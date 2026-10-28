from __future__ import annotations

import json
import math
import os
import shutil
import sqlite3
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

from .errors import (FolderNameExists, FolderNotFound, InvalidFolderName, InvalidPosition,
                     InvalidPlayability, InvalidScoreTrackInstrument, ScoreTrackAmbiguous, ScoreTrackInstrumentAmbiguous,
                     ScoreTrackInstrumentNotEditable, ScoreTrackNotFound, SongNotFound)
from .paths import home


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


class LibraryStore:
    def __init__(self, path: Path | None = None):
        self.path = path or home() / "mizan.db"
        with closing(self._connect()) as connection, connection:
            connection.execute("""
                CREATE TABLE IF NOT EXISTS songs (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    artist TEXT,
                    thumbnail TEXT,
                    source TEXT NOT NULL CHECK (source IN ('youtube', 'midi', 'musicxml')),
                    parts TEXT NOT NULL,
                    recording INTEGER NOT NULL,
                    duration REAL,
                    created_at TEXT NOT NULL,
                    practiced_at TEXT,
                    position TEXT,
                    pipeline_version TEXT NOT NULL,
                    source_url TEXT,
                    artifacts TEXT NOT NULL,
                    song_path TEXT NOT NULL,
                    tempo_map TEXT,
                    transcription_model TEXT,
                    separation_method TEXT
                )
            """)
            columns = {row["name"] for row in connection.execute("PRAGMA table_info(songs)")}
            migrating_processing = "transcription_model" not in columns or "separation_method" not in columns
            if "artist" not in columns:
                connection.execute("ALTER TABLE songs ADD COLUMN artist TEXT")
            if "transcription_model" not in columns:
                connection.execute("ALTER TABLE songs ADD COLUMN transcription_model TEXT")
            if "separation_method" not in columns:
                connection.execute("ALTER TABLE songs ADD COLUMN separation_method TEXT")
            job_columns = {row["name"] for row in connection.execute("PRAGMA table_info(jobs)")}
            if migrating_processing and {"transcription_model", "kind"} <= job_columns:
                for job in connection.execute("""
                    SELECT transcription_model, details FROM jobs
                    WHERE status = 'done' AND kind = 'transcribe' ORDER BY updated_at DESC
                """):
                    details = json.loads(job["details"])
                    analysis = (details.get("artifacts") or {}).get("analysis")
                    if analysis:
                        connection.execute("""
                            UPDATE songs SET transcription_model = ?, separation_method = ?
                            WHERE source = 'youtube' AND song_path = ? AND transcription_model IS NULL
                        """, (job["transcription_model"],
                              (details.get("diagnostics") or {}).get("separate", {}).get("method"), analysis))
            connection.execute("""
                CREATE TABLE IF NOT EXISTS folders (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL COLLATE NOCASE UNIQUE,
                    created_at TEXT NOT NULL,
                    sort INTEGER NOT NULL
                )
            """)
            connection.execute("""
                CREATE TABLE IF NOT EXISTS folder_songs (
                    folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
                    song_id TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
                    PRIMARY KEY (folder_id, song_id)
                )
            """)
            connection.execute("REINDEX folders")

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path)
        connection.row_factory = sqlite3.Row
        connection.create_collation("NOCASE", lambda a, b:
                                    (a.casefold() > b.casefold()) - (a.casefold() < b.casefold()))
        connection.execute("PRAGMA foreign_keys = ON")
        return connection

    @staticmethod
    def _song(row) -> dict[str, Any]:
        song = dict(row)
        for name in ("parts", "position", "artifacts", "tempo_map"):
            song[name] = json.loads(song[name]) if song[name] else None
        song["recording"] = bool(song["recording"])
        folder_ids = song.pop("folder_ids", None)
        song["folders"] = folder_ids.split(",") if folder_ids else []
        return song

    def create_import(self, title: str, source: str, song: dict, artifacts: dict[str, str],
                      pipeline_version: str, song_id: str | None = None,
                      entry_metadata: dict | None = None) -> dict:
        song_id, timestamp = song_id or str(uuid4()), now()
        song_path = artifacts["analysis"]
        parts = [track["name"] for track in song["tracks"]]
        metadata = entry_metadata or {}
        # A downloaded score's license and attribution live in a small file beside its analysis, listed with the
        # song's other artifacts, so the library's table keeps its existing columns.
        rights = {key: metadata[key] for key in ("license", "attribution", "provider") if metadata.get(key)}
        if rights:
            sidecar = Path(song_path).with_name("source.json")
            sidecar.write_text(json.dumps(rights, ensure_ascii=False), encoding="utf-8")
            artifacts = {**artifacts, "source": str(sidecar)}
        with closing(self._connect()) as connection, connection:
            connection.execute("""
                INSERT INTO songs (id, title, thumbnail, source, parts, recording, duration,
                    created_at, practiced_at, position, pipeline_version, source_url,
                    artifacts, song_path, tempo_map, artist)
                VALUES (?, ?, NULL, ?, ?, 0, NULL, ?, NULL, NULL, ?, ?, ?, ?, NULL, ?)
            """, (song_id, title, source, json.dumps(parts), timestamp, pipeline_version,
                  metadata.get("sourceUrl"), json.dumps(artifacts), song_path, metadata.get("artist")))
        return self.get(song_id)

    def upsert_job(self, job: dict, pipeline_version: str) -> dict | None:
        details = job.get("details") or {}
        artifacts = details.get("artifacts") or {}
        analysis = artifacts.get("analysis")
        if not analysis or not Path(analysis).is_file():
            return None
        song = json.loads(Path(analysis).read_text(encoding="utf-8"))
        metadata = details.get("metadata") or {}
        song_id = job.get("song_id") or str(uuid4())
        previous = None
        try:
            previous = self.get(song_id)
        except SongNotFound:
            pass
        timestamp = previous["created_at"] if previous else now()
        parts = [track["name"] for track in song.get("tracks", [])
                 if track.get("group") != "creative" and track.get("id") != "accompaniment"]
        separation = song.get("diagnostics", {}).get("separate", {}).get("method")
        values = (
            song_id, song.get("title") or metadata.get("title") or "Untitled",
            metadata.get("thumbnail"), "youtube", json.dumps(parts), 1,
            metadata.get("duration") or song.get("durationSeconds"), timestamp,
            previous.get("practiced_at") if previous else None,
            json.dumps(previous.get("position")) if previous and previous.get("position") else None,
            pipeline_version, job["url"], json.dumps(artifacts), analysis,
            json.dumps(song.get("tempoMap")) if song.get("tempoMap") else None,
            metadata.get("channel") or metadata.get("uploader"),
            job.get("transcription_model"), separation,
        )
        with closing(self._connect()) as connection, connection:
            connection.execute("""
                INSERT INTO songs (id, title, thumbnail, source, parts, recording,
                    duration, created_at, practiced_at, position, pipeline_version, source_url,
                    artifacts, song_path, tempo_map, artist, transcription_model, separation_method)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    title = excluded.title, thumbnail = excluded.thumbnail,
                    source = excluded.source, parts = excluded.parts,
                    recording = excluded.recording, duration = excluded.duration,
                    practiced_at = excluded.practiced_at, position = excluded.position,
                    pipeline_version = excluded.pipeline_version,
                    source_url = excluded.source_url, artifacts = excluded.artifacts,
                    song_path = excluded.song_path, tempo_map = excluded.tempo_map,
                    artist = excluded.artist,
                    transcription_model = excluded.transcription_model,
                    separation_method = excluded.separation_method
            """, values)
        return self.get(song_id)

    def get(self, song_id: str) -> dict:
        if not isinstance(song_id, str) or not song_id:
            raise SongNotFound()
        with closing(self._connect()) as connection:
            row = connection.execute("""
                SELECT songs.*, GROUP_CONCAT(folder_songs.folder_id) AS folder_ids
                FROM songs
                LEFT JOIN folder_songs ON folder_songs.song_id = songs.id
                WHERE songs.id = ?
                GROUP BY songs.id
            """, (song_id,)).fetchone()
        if row is None:
            raise SongNotFound()
        return self._song(row)

    def list(self) -> list[dict]:
        with closing(self._connect()) as connection:
            rows = connection.execute("""
                SELECT songs.*, GROUP_CONCAT(folder_songs.folder_id) AS folder_ids
                FROM songs
                LEFT JOIN folder_songs ON folder_songs.song_id = songs.id
                GROUP BY songs.id
                ORDER BY COALESCE(practiced_at, created_at) DESC
            """)
            return [self._song(row) for row in rows]

    @staticmethod
    def _folder_name(name: str) -> str:
        if not isinstance(name, str):
            raise InvalidFolderName()
        name = name.strip()
        if not name or len(name) > 60:
            raise InvalidFolderName()
        return name

    def list_folders(self) -> list[dict]:
        with closing(self._connect()) as connection:
            rows = connection.execute("""
                SELECT folders.id, folders.name, COUNT(folder_songs.song_id) AS count
                FROM folders
                LEFT JOIN folder_songs ON folder_songs.folder_id = folders.id
                GROUP BY folders.id
                ORDER BY folders.sort, folders.created_at
            """)
            return [dict(row) for row in rows]

    def create_folder(self, name: str) -> dict:
        name = self._folder_name(name)
        folder_id = str(uuid4())
        with closing(self._connect()) as connection, connection:
            sort = connection.execute("SELECT COALESCE(MAX(sort), -1) + 1 FROM folders").fetchone()[0]
            try:
                connection.execute(
                    "INSERT INTO folders (id, name, created_at, sort) VALUES (?, ?, ?, ?)",
                    (folder_id, name, now(), sort),
                )
            except sqlite3.IntegrityError as exc:
                raise FolderNameExists() from exc
        return next(folder for folder in self.list_folders() if folder["id"] == folder_id)

    def rename_folder(self, folder_id: str, name: str) -> dict:
        name = self._folder_name(name)
        with closing(self._connect()) as connection, connection:
            try:
                cursor = connection.execute(
                    "UPDATE folders SET name = ? WHERE id = ?", (name, folder_id)
                )
            except sqlite3.IntegrityError as exc:
                raise FolderNameExists() from exc
            if cursor.rowcount != 1:
                raise FolderNotFound()
        return next(folder for folder in self.list_folders() if folder["id"] == folder_id)

    def delete_folder(self, folder_id: str) -> None:
        with closing(self._connect()) as connection, connection:
            cursor = connection.execute("DELETE FROM folders WHERE id = ?", (folder_id,))
            if cursor.rowcount != 1:
                raise FolderNotFound()

    def set_song_folders(self, song_id: str, folder_ids: list[str]) -> None:
        if not isinstance(folder_ids, list) or any(not isinstance(value, str) for value in folder_ids):
            raise FolderNotFound()
        folder_ids = list(dict.fromkeys(folder_ids))
        with closing(self._connect()) as connection, connection:
            if connection.execute("SELECT 1 FROM songs WHERE id = ?", (song_id,)).fetchone() is None:
                raise SongNotFound()
            if folder_ids:
                found = connection.execute(
                    f"SELECT COUNT(*) FROM folders WHERE id IN ({','.join('?' for _ in folder_ids)})",
                    folder_ids,
                ).fetchone()[0]
                if found != len(folder_ids):
                    raise FolderNotFound()
            connection.execute("DELETE FROM folder_songs WHERE song_id = ?", (song_id,))
            connection.executemany(
                "INSERT INTO folder_songs (folder_id, song_id) VALUES (?, ?)",
                ((folder_id, song_id) for folder_id in folder_ids),
            )

    def save_position(self, song_id: str, position: dict) -> None:
        if not isinstance(position, dict):
            raise InvalidPosition()
        required = {"bar", "loop", "rate", "trackId", "muted", "solo"}
        if not required <= position.keys() or not isinstance(position["bar"], (int, float)) \
                or position["bar"] < 1 or not isinstance(position["rate"], (int, float)) \
                or position["rate"] <= 0 or not isinstance(position["trackId"], str) \
                or not all(isinstance(position[name], list) and
                           all(isinstance(value, str) for value in position[name])
                           for name in ("muted", "solo")):
            raise InvalidPosition()
        if "loopName" in position and position["loopName"] is not None \
                and not isinstance(position["loopName"], str):
            raise InvalidPosition()
        loop = position["loop"]
        if loop is not None and (not isinstance(loop, dict) or set(loop) != {"startBar", "endBar"}
                                 or loop["startBar"] < 1 or loop["endBar"] < loop["startBar"]):
            raise InvalidPosition()
        with closing(self._connect()) as connection, connection:
            cursor = connection.execute("""
                UPDATE songs SET position = ?, practiced_at = ? WHERE id = ?
            """, (json.dumps(position, allow_nan=False), now(), song_id))
            if cursor.rowcount != 1:
                raise SongNotFound()

    @staticmethod
    def _validate_playability_summary(summary: Any, instrument: str, note_count: int) -> dict:
        fields = ("flagged", "moved", "octaveAdjusted", "unplayable", "unplayableNotes", "warnings")
        if not isinstance(summary, dict) or summary.get("instrument") != instrument \
                or any(type(summary.get(field)) is not int or summary[field] < 0 for field in fields) \
                or not isinstance(summary.get("issues"), list):
            raise InvalidPlayability()
        if any(summary[field] > note_count for field in fields):
            raise InvalidPlayability()
        for issue in summary["issues"]:
            if not isinstance(issue, dict) or type(issue.get("beat")) not in (int, float) \
                    or not math.isfinite(issue["beat"]) or issue["beat"] < 0 \
                    or issue.get("kind") not in ("moved", "octave", "unplayable", "jump", "repeat") \
                    or type(issue.get("count")) is not int or issue["count"] < 1:
                raise InvalidPlayability()
        return summary

    @staticmethod
    def _validate_optimized_notes(source: Any, optimized: Any, *, drum: bool = False) -> None:
        if not isinstance(source, list) or not isinstance(optimized, list) or len(source) != len(optimized):
            raise InvalidPlayability()
        allowed = {"hand"} if drum else {
            "midi", "hand", "finger", "string", "fret", "adjusted", "notPlayable",
        }
        for original, result in zip(source, optimized):
            if not isinstance(original, dict) or not isinstance(result, dict):
                raise InvalidPlayability()
            for field in (original.keys() | result.keys()) - allowed:
                if original.get(field) != result.get(field) or (field in original) != (field in result):
                    raise InvalidPlayability()
            if drum:
                if result.get("hand") not in (None, "left", "right"):
                    raise InvalidPlayability()
                continue
            midi = result.get("midi")
            if type(midi) not in (int, float) or not math.isfinite(midi) or not 0 <= midi <= 127:
                raise InvalidPlayability()
            if result.get("hand") not in (None, "left", "right") \
                    or result.get("finger") not in (None, 1, 2, 3, 4, 5) \
                    or type(result.get("string", 1)) is not int or type(result.get("fret", 0)) is not int \
                    or result.get("string", 1) < 1 or result.get("fret", 0) < 0:
                raise InvalidPlayability()
            if any(type(result.get(flag, False)) is not bool for flag in ("adjusted", "notPlayable")):
                raise InvalidPlayability()

    @staticmethod
    def _playability_source(song: dict, key: str) -> list | None:
        if key == "piano":
            return song.get("piano")
        track_id = key.removeprefix("track:") if key.startswith("track:") else key
        if not track_id:
            return None
        tracks = [track for track in song.get("tracks", [])
                  if isinstance(track, dict) and track.get("id") == track_id and track.get("group") != "creative"]
        if len(tracks) != 1:
            return None
        track = tracks[0]
        if track.get("instrument") == "piano":
            return [note for note in song.get("piano", []) if note.get("trackId") == track_id]
        notes = song.get("instrumentNotes", {}).get(track_id)
        return notes if isinstance(notes, list) else None

    def save_playability(self, song_id: str, result: dict) -> None:
        if not isinstance(result, dict) or result.get("version") != "constrained-path-v5" \
                or not isinstance(result.get("parts"), dict) \
                or not result["parts"] and not isinstance(result.get("drums"), dict):
            raise InvalidPlayability()
        with closing(self._connect()) as connection, connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute("SELECT song_path FROM songs WHERE id = ?", (song_id,)).fetchone()
            if row is None:
                raise SongNotFound()
            path = Path(row["song_path"])
            try:
                song = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError) as exc:
                raise InvalidPlayability() from exc

            stored_parts = {}
            for key, part in result["parts"].items():
                if not isinstance(key, str) or not key or not isinstance(part, dict) \
                        or not isinstance(part.get("sourceSignature"), str) \
                        or not isinstance(part.get("sourceNotes"), list):
                    raise InvalidPlayability()
                expected = self._playability_source(song, key)
                if expected is None or part["sourceNotes"] != expected:
                    raise InvalidPlayability()
                self._validate_optimized_notes(expected, part.get("notes"))
                summary = part.get("summary")
                if not isinstance(summary, dict) or summary.get("instrument") not in ("piano", "guitar", "bass"):
                    raise InvalidPlayability()
                summary = self._validate_playability_summary(summary, summary["instrument"], len(expected))
                if len(part["sourceSignature"]) > 100:
                    raise InvalidPlayability()
                stored_parts[key] = {
                    "sourceSignature": part["sourceSignature"], "notes": part["notes"], "summary": summary,
                }

            drums = result.get("drums")
            stored_drums = None
            if drums is not None:
                if not isinstance(drums, dict) or not isinstance(drums.get("sourceSignature"), str) \
                        or not isinstance(drums.get("sourceHits"), list) \
                        or not isinstance(drums.get("trackSummaries"), dict) \
                        or drums["sourceHits"] != song.get("drums"):
                    raise InvalidPlayability()
                self._validate_optimized_notes(drums["sourceHits"], drums.get("hits"), drum=True)
                if any(source.get("hand") and source.get("hand") != optimized.get("hand")
                       for source, optimized in zip(drums["sourceHits"], drums["hits"])):
                    raise InvalidPlayability()
                summary = self._validate_playability_summary(
                    drums.get("summary"), "drums", len(drums["sourceHits"]))
                source_track_ids = {
                    hit.get("trackId") for hit in drums["sourceHits"]
                    if isinstance(hit.get("trackId"), str) and hit.get("trackId")
                }
                if set(drums["trackSummaries"]) != source_track_ids:
                    raise InvalidPlayability()
                track_summaries = {}
                for track_id, track_summary in drums["trackSummaries"].items():
                    if not isinstance(track_id, str) or not track_id:
                        raise InvalidPlayability()
                    count = sum(hit.get("trackId") == track_id for hit in drums["sourceHits"])
                    track_summaries[track_id] = self._validate_playability_summary(
                        track_summary, "drums", count)
                if len(drums["sourceSignature"]) > 100:
                    raise InvalidPlayability()
                stored_drums = {
                    "sourceSignature": drums["sourceSignature"], "hits": drums["hits"], "summary": summary,
                    "trackSummaries": track_summaries,
                }

            song["playability"] = {
                "version": result["version"], "parts": stored_parts,
                **({"drums": stored_drums} if stored_drums else {}),
            }
            temporary = path.with_name(f".{path.name}.{uuid4().hex}.tmp")
            try:
                temporary.write_text(json.dumps(song, ensure_ascii=True, allow_nan=False), encoding="utf-8")
                os.replace(temporary, path)
            finally:
                temporary.unlink(missing_ok=True)

    def update_recording(self, song_id: str, artifacts: dict, song: dict, tempo_map: list[dict]) -> dict:
        with closing(self._connect()) as connection, connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT song_path, artifacts FROM songs WHERE id = ?", (song_id,)).fetchone()
            if row is None:
                raise SongNotFound()
            path = Path(row["song_path"])
            try:
                current_song = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError) as exc:
                raise InvalidPlayability() from exc
            from .alignment import apply_tempo_map

            updated_song = apply_tempo_map(current_song, tempo_map)
            if "durationSeconds" in song:
                updated_song["durationSeconds"] = song["durationSeconds"]
            updated_song.pop("playability", None)
            updated_artifacts = json.loads(row["artifacts"])
            if artifacts.get("mix") is not None:
                updated_artifacts["mix"] = artifacts["mix"]
            analysis = path.with_name(f"analysis-{uuid4().hex}.json")
            try:
                analysis.write_text(json.dumps(updated_song, ensure_ascii=True, allow_nan=False), encoding="utf-8")
                updated_artifacts["analysis"] = str(analysis)
                cursor = connection.execute("""
                    UPDATE songs
                    SET recording = 1, duration = ?, artifacts = ?, tempo_map = ?, song_path = ?
                    WHERE id = ? AND song_path = ?
                """, (updated_song.get("durationSeconds"), json.dumps(updated_artifacts),
                      json.dumps(tempo_map), str(analysis), song_id, str(path)))
                if cursor.rowcount != 1:
                    raise SongNotFound()
            except Exception:
                analysis.unlink(missing_ok=True)
                raise
        return self.get(song_id)

    def _commit_score_revision(self, song_id: str, entry: dict, path: Path, song: dict,
                               export_song: dict, parts: list[str], position: dict | None,
                               stale_message: str, *, preserve_position: bool = False) -> dict:
        from .engine.output import export_midi, export_musicxml

        revision = uuid4().hex
        song.pop("playability", None)
        analysis = path.with_name(f"analysis-{revision}.json")
        midi = path.with_name(f"score-{revision}.mid")
        musicxml = path.with_name(f"score-{revision}.musicxml")
        artifacts = {**entry["artifacts"], "analysis": str(analysis),
                     "midi": str(midi), "musicxml": str(musicxml)}
        try:
            analysis.write_text(json.dumps(song, ensure_ascii=True, allow_nan=False), encoding="utf-8")
            export_midi(export_song, midi)
            export_musicxml(export_song, musicxml)
            with closing(self._connect()) as connection, connection:
                if preserve_position:
                    cursor = connection.execute("""
                        UPDATE songs SET parts = ?, artifacts = ?, song_path = ?
                        WHERE id = ? AND song_path = ?
                    """, (json.dumps(parts), json.dumps(artifacts), str(analysis), song_id, str(path)))
                else:
                    cursor = connection.execute("""
                        UPDATE songs SET parts = ?, position = ?, artifacts = ?, song_path = ?
                        WHERE id = ? AND song_path = ?
                    """, (json.dumps(parts), json.dumps(position), json.dumps(artifacts),
                          str(analysis), song_id, str(path)))
                if cursor.rowcount != 1:
                    raise SongNotFound(stale_message)
        except Exception:
            for output in (analysis, midi, musicxml):
                output.unlink(missing_ok=True)
            raise
        return self.get(song_id)

    @staticmethod
    def _score_for_export(song: dict, tracks: list[dict]) -> dict:
        from .engine.output import exportable_track

        export_song = {**song}
        for item in tracks:
            if item.get("group") == "detected":
                if exportable_track(item):
                    export_song.setdefault(item["id"], song.get("instrumentNotes", {}).get(item["id"], []))
                continue
            if item.get("group") == "creative":
                if item["id"] in song:
                    export_song[item["id"]] = song[item["id"]]
                continue
            if item["instrument"] == "other":
                if exportable_track(item):
                    export_song.setdefault(item["id"], song.get("instrumentNotes", {}).get(item["id"], []))
                continue
            source = song.get(item["instrument"], [])
            export_song[item["id"]] = [event for event in source
                                       if event.get("trackId", item["id"]) == item["id"]
                                       or ("trackId" not in event and sum(
                                           part["instrument"] == item["instrument"] for part in tracks
                                           if part.get("group") != "creative") == 1)]
        export_song["tracks"] = [item for item in tracks if item["id"] in export_song]
        return export_song

    def change_score_track_instrument(self, song_id: str, track_id: str, gm_program: int) -> dict:
        from .engine.gm import GM_PROGRAM_NAMES, gm_program_name

        if type(gm_program) is not int or not 0 <= gm_program < len(GM_PROGRAM_NAMES):
            raise InvalidScoreTrackInstrument()
        if not isinstance(track_id, str) or not track_id:
            raise ScoreTrackNotFound()
        entry = self.get(song_id)
        path = Path(entry["song_path"])
        song = json.loads(path.read_text(encoding="utf-8"))
        tracks = song.get("tracks")
        if not isinstance(tracks, list):
            raise ScoreTrackNotFound()
        matches = [item for item in tracks if isinstance(item, dict) and item.get("id") == track_id]
        if len(matches) > 1:
            raise ScoreTrackInstrumentAmbiguous()
        track = matches[0] if matches else None
        if track is None or track.get("group") == "creative":
            raise ScoreTrackNotFound()
        instrument = track.get("instrument")
        if instrument not in ("piano", "vocals", "other"):
            raise ScoreTrackInstrumentNotEditable()

        instrument_notes = song.get("instrumentNotes")
        if instrument_notes is None:
            instrument_notes = {}
        if not isinstance(instrument_notes, dict):
            raise ScoreTrackInstrumentAmbiguous()
        for owner_id, notes in instrument_notes.items():
            if not isinstance(owner_id, str) or not isinstance(notes, list) or any(
                    not isinstance(event, dict) or event.get("trackId", owner_id) != owner_id
                    for event in notes):
                raise ScoreTrackInstrumentAmbiguous()
        for owner_id, notes in instrument_notes.items():
            if owner_id != track_id and any(event.get("trackId") == track_id for event in notes):
                raise ScoreTrackInstrumentAmbiguous()

        if instrument == "other":
            events = instrument_notes.get(track_id)
            if not isinstance(events, list):
                raise ScoreTrackInstrumentAmbiguous()
            selected_events = events
        else:
            source_events = song.get(instrument)
            if not isinstance(source_events, list) or any(not isinstance(event, dict) for event in source_events):
                raise ScoreTrackInstrumentAmbiguous()
            same_instrument = [
                item for item in tracks
                if isinstance(item, dict) and item.get("group") != "creative" and item.get("instrument") == instrument
            ]
            same_ids = [item.get("id") for item in same_instrument]
            if (any(not isinstance(owner_id, str) or not owner_id for owner_id in same_ids) or
                    len(same_ids) != len(set(same_ids)) or track_id in instrument_notes):
                raise ScoreTrackInstrumentAmbiguous()
            selected_events = []
            remaining_events = []
            for event in source_events:
                owner_id = event.get("trackId")
                if owner_id is None:
                    if "trackId" in event or len(same_instrument) != 1:
                        raise ScoreTrackInstrumentAmbiguous()
                    selected_events.append(event)
                elif owner_id == track_id:
                    selected_events.append(event)
                elif owner_id in same_ids:
                    remaining_events.append(event)
                else:
                    raise ScoreTrackInstrumentAmbiguous()

        updated_track = dict(track)
        correction = updated_track.get("instrumentCorrection")
        if not isinstance(correction, dict):
            original_program = updated_track.get("gmProgram")
            if type(original_program) is not int or not 0 <= original_program <= 127:
                from .engine.output import detected_gm_program
                source_instrument = updated_track.get("sourceInstrument")
                original_program = detected_gm_program(source_instrument) if type(source_instrument) is str else None
            correction = {
                "detectedName": updated_track.get("name", ""),
                "detectedInstrument": instrument,
                "detectedGmProgram": original_program,
                "sourceInstrument": updated_track.get("sourceInstrument"),
            }
        updated_track["instrumentCorrection"] = {**correction, "gmProgram": gm_program}
        updated_track["gmProgram"] = gm_program
        updated_track["name"] = gm_program_name(gm_program)
        updated_track["instrument"] = "other"
        updated_tracks = [updated_track if item is track else item for item in tracks]
        updated_song = {
            **song,
            "tracks": updated_tracks,
            "instrumentNotes": {**instrument_notes, track_id: selected_events},
        }
        if instrument != "other":
            updated_song[instrument] = remaining_events
        parts = [item["name"] for item in updated_tracks if item.get("group") != "creative"]
        export_song = self._score_for_export(updated_song, updated_tracks)
        return self._commit_score_revision(
            song_id, entry, path, updated_song, export_song, parts, None,
            "The saved score changed while changing this instrument. Reopen the song and try again.",
            preserve_position=True,
        )

    def delete_score_track(self, song_id: str, track_id: str) -> dict:
        entry = self.get(song_id)
        if not isinstance(track_id, str):
            raise ScoreTrackNotFound()
        path = Path(entry["song_path"])
        song = json.loads(path.read_text(encoding="utf-8"))

        def deletable(item: dict) -> bool:
            if item.get("group") == "creative":
                return False
            if item["instrument"] in ("piano", "drums", "vocals"):
                return True
            correction = item.get("instrumentCorrection")
            return item["instrument"] == "other" and (
                item.get("group") == "detected"
                or isinstance(correction, dict)
                and correction.get("detectedInstrument") in ("piano", "vocals")
            )

        track = next((item for item in song["tracks"]
                      if item["id"] == track_id and deletable(item)), None)
        if track is None:
            raise ScoreTrackNotFound()
        instrument = track["instrument"]
        events = (song.get("instrumentNotes", {}).get(track_id, [])
                  if instrument == "other" else song.get(instrument, []))
        same_instrument = [item for item in song["tracks"]
                           if item.get("group") != "creative" and item["instrument"] == instrument]
        known_ids = {item["id"] for item in same_instrument}
        if any(event.get("trackId", track_id) not in known_ids for event in events) or \
                (len(same_instrument) > 1 and any("trackId" not in event for event in events)):
            raise ScoreTrackAmbiguous()
        remaining = [item for item in song["tracks"] if item["id"] != track_id]
        song = {**song, "tracks": remaining}
        if instrument == "other":
            song["instrumentNotes"] = {
                key: value for key, value in song.get("instrumentNotes", {}).items()
                if key != track_id}
            song["detectedInstrumentTracks"] = [
                item for item in song.get("detectedInstrumentTracks", [])
                if item["id"] != track_id]
        else:
            song[instrument] = [event for event in events if event.get("trackId", track_id) != track_id]
        if not any(item["instrument"] == instrument and item.get("group") != "creative" for item in remaining):
            song["confidence"] = {**song.get("confidence", {}), instrument: []}
        parts = [item["name"] for item in remaining if item.get("group") != "creative"]
        position = entry["position"]
        if position:
            position = {**position,
                        "trackId": remaining[0]["id"] if position["trackId"] == track_id and remaining else
                        "" if position["trackId"] == track_id else position["trackId"],
                        "muted": [value for value in position["muted"] if value != track_id],
                        "solo": [value for value in position["solo"] if value != track_id]}

        # Exports contain only the remaining score; imported originals and recording stems stay untouched.
        export_song = self._score_for_export(song, remaining)
        return self._commit_score_revision(
            song_id, entry, path, song, export_song, parts, position,
            "The saved score changed while deleting this track. Reopen the song and try again.",
        )

    def delete(self, song_id: str) -> None:
        entry = self.get(song_id)
        directories = {Path(path).parent for path in entry["artifacts"].values()}
        with closing(self._connect()) as connection, connection:
            connection.execute("DELETE FROM songs WHERE id = ?", (song_id,))
        for directory in directories:
            if directory.is_dir() and directory.parent == home() / "cache":
                shutil.rmtree(directory)


def _rights(entry: dict) -> dict:
    """A downloaded score's license and attribution, from the source file listed with its artifacts."""
    path = (entry.get("artifacts") or {}).get("source")
    try:
        rights = json.loads(Path(path).read_text(encoding="utf-8")) if path else {}
    except (OSError, ValueError):
        rights = {}
    return {
        "license": rights.get("license"),
        "attribution": rights.get("attribution"),
        "provider": rights.get("provider"),
    }


def public_entry(entry: dict, pipeline_version: str) -> dict:
    return {
        "id": entry["id"], "title": entry["title"], "thumbnail": entry["thumbnail"],
        "artist": entry.get("artist"),
        "sourceUrl": entry.get("source_url"),
        **_rights(entry),
        "source": entry["source"], "parts": entry["parts"] or [],
        "recording": entry["recording"], "duration": entry["duration"],
        "createdAt": entry["created_at"], "practicedAt": entry["practiced_at"],
        "position": entry["position"], "folders": entry.get("folders", []),
        "outdated": entry["pipeline_version"] != pipeline_version,
        "transcriptionModel": entry["transcription_model"],
        "separationMethod": entry["separation_method"],
    }
