from __future__ import annotations

import json
import logging
import math
import os
import sqlite3
import time
from collections.abc import Callable
from contextlib import closing
from datetime import datetime, timedelta, timezone
from pathlib import Path
from threading import Condition, Event, Lock, Thread
from typing import Any
from uuid import uuid4

from .errors import Cancelled, InvalidInstrument, InvalidTranscriptionModel, JobNotFound, MizanError
from .engine import VERSION
from .library import LibraryStore
from .paths import home
from .youtube import parse_video_id

STAGES = ("inspect", "download", "decode", "detect", "separate", "transcribe",
          "chords", "notation", "finalize")
ALL_STAGES = (*STAGES[:-1], "align", "finalize")
PIPELINE_VERSION = "0.3.1-" + VERSION
TRANSCRIPTION_MODELS = ("muscriptor-small", "muscriptor-medium", "muscriptor-large")
Job = dict[str, Any]
Pipeline = Callable[[Job, Callable[[str, float], None], Event], dict | None]
logger = logging.getLogger(__name__)


def _smaller_retry_model(job: Job, model: str) -> str:
    if job["kind"] != "transcribe":
        raise MizanError("Only transcription jobs can be retried with a smaller MuScriptor model.")
    if model not in TRANSCRIPTION_MODELS:
        raise InvalidTranscriptionModel()
    if job["transcription_model"] not in TRANSCRIPTION_MODELS:
        raise InvalidTranscriptionModel()
    if TRANSCRIPTION_MODELS.index(model) >= TRANSCRIPTION_MODELS.index(job["transcription_model"]):
        raise MizanError("Choose a smaller MuScriptor model for this retry.")
    return model


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _elapsed_seconds(started_at: str | None, finished_at: str | None) -> float | None:
    if not isinstance(started_at, str) or not isinstance(finished_at, str):
        return None
    try:
        started = datetime.fromisoformat(started_at)
        finished = datetime.fromisoformat(finished_at)
    except ValueError:
        return None
    if started.tzinfo is None:
        started = started.replace(tzinfo=timezone.utc)
    if finished.tzinfo is None:
        finished = finished.replace(tzinfo=timezone.utc)
    return max(0.0, (finished - started).total_seconds())


def _schema(connection: sqlite3.Connection) -> None:
    connection.execute("""
        CREATE TABLE jobs (
            id TEXT PRIMARY KEY,
            video_id TEXT NOT NULL,
            url TEXT NOT NULL,
            instrument TEXT NOT NULL CHECK (instrument IN ('auto', 'piano', 'drums')),
            kind TEXT NOT NULL DEFAULT 'transcribe' CHECK (kind IN ('transcribe', 'align')),
            song_id TEXT,
            title TEXT,
            thumbnail TEXT,
            stage TEXT NOT NULL CHECK (stage IN (
                'inspect', 'download', 'decode', 'detect', 'separate',
                'transcribe', 'chords', 'notation', 'align', 'finalize'
            )),
            status TEXT NOT NULL CHECK (status IN (
                'queued', 'running', 'done', 'failed', 'cancelled'
            )),
            progress REAL NOT NULL CHECK (progress BETWEEN 0 AND 1),
            order_index INTEGER NOT NULL,
            dismissed INTEGER NOT NULL DEFAULT 0,
            error_code TEXT,
            error_message TEXT,
            pipeline_version TEXT NOT NULL,
            transcription_model TEXT NOT NULL DEFAULT 'muscriptor-small'
                CHECK (transcription_model IN ('standard', 'muscriptor-small', 'muscriptor-medium', 'muscriptor-large')),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            details TEXT NOT NULL DEFAULT '{}'
        )
    """)
    connection.execute("""
        CREATE INDEX IF NOT EXISTS jobs_cache
        ON jobs (video_id, instrument, pipeline_version, status)
    """)


class JobStore:
    def __init__(self):
        self.path = home() / "mizan.db"
        with closing(self._connect()) as connection, connection:
            table = connection.execute("""
                SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'jobs'
            """).fetchone()
            if table is None:
                _schema(connection)
            elif ("'detect'" not in table["sql"] or "order_index" not in table["sql"]
                  or ("transcription_model" in table["sql"] and "'muscriptor-medium'" not in table["sql"])):
                connection.execute("ALTER TABLE jobs RENAME TO jobs_legacy")
                _schema(connection)
                columns = {row["name"] for row in connection.execute("PRAGMA table_info(jobs_legacy)")}
                details = "details" if "details" in columns else "'{}'"
                model = "transcription_model" if "transcription_model" in columns else "'standard'"
                kind = "kind" if "kind" in columns else "'transcribe'"
                song_id = "song_id" if "song_id" in columns else "NULL"
                title = "title" if "title" in columns else "NULL"
                thumbnail = "thumbnail" if "thumbnail" in columns else "NULL"
                order_index = "order_index" if "order_index" in columns else "rowid"
                dismissed = "dismissed" if "dismissed" in columns else "0"
                connection.execute(f"""
                    INSERT INTO jobs (id, video_id, url, instrument, kind, song_id, title,
                        thumbnail, stage, status, progress, order_index, dismissed, error_code,
                        error_message, pipeline_version, transcription_model, created_at, updated_at, details)
                    SELECT id, video_id, url, instrument, {kind}, {song_id}, {title}, {thumbnail},
                        stage, CASE WHEN status = 'running' THEN 'queued' ELSE status END,
                        progress, {order_index}, {dismissed}, error_code, error_message, pipeline_version, {model},
                        created_at, updated_at, {details}
                    FROM jobs_legacy
                """)
                connection.execute("DROP TABLE jobs_legacy")
                connection.execute("""
                    CREATE INDEX IF NOT EXISTS jobs_cache
                    ON jobs (video_id, instrument, pipeline_version, status)
                """)
            else:
                connection.execute("UPDATE jobs SET status = 'queued' WHERE status = 'running'")
            columns = {row["name"] for row in connection.execute("PRAGMA table_info(jobs)")}
            if "transcription_model" not in columns:
                connection.execute("ALTER TABLE jobs ADD COLUMN transcription_model TEXT NOT NULL DEFAULT 'standard'")
            connection.execute("""
                CREATE TABLE IF NOT EXISTS settings (
                    key TEXT PRIMARY KEY, value TEXT NOT NULL
                )
            """)
            connection.execute("""
                UPDATE settings SET value = 'muscriptor-small'
                WHERE key = 'transcription_model' AND value = 'standard'
            """)
            connection.execute("""
                UPDATE jobs SET status = 'failed', error_code = 'invalid_transcription_model',
                    error_message = 'Standard transcription was removed. Choose a MuScriptor size and start a new job.'
                WHERE kind = 'transcribe' AND transcription_model = 'standard'
                    AND status IN ('queued', 'running')
            """)

    def get_transcription_model(self) -> str:
        with closing(self._connect()) as connection:
            row = connection.execute(
                "SELECT value FROM settings WHERE key = 'transcription_model'").fetchone()
        return row[0] if row else "muscriptor-small"

    def set_transcription_model(self, model: str) -> str:
        if not isinstance(model, str) or model not in TRANSCRIPTION_MODELS:
            raise InvalidTranscriptionModel()
        with closing(self._connect()) as connection, connection:
            connection.execute("""
                INSERT INTO settings (key, value) VALUES ('transcription_model', ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value
            """, (model,))
        return model

    def get_ffmpeg_path(self) -> str | None:
        with closing(self._connect()) as connection:
            row = connection.execute(
                "SELECT value FROM settings WHERE key = 'ffmpeg_path'").fetchone()
        return row[0] if row else None

    def set_ffmpeg_path(self, path: str | None) -> None:
        if path is not None and (type(path) is not str or not path):
            raise ValueError("FFmpeg path must be a non-empty string or None.")
        with closing(self._connect()) as connection, connection:
            if path is None:
                connection.execute("DELETE FROM settings WHERE key = 'ffmpeg_path'")
            else:
                connection.execute("""
                    INSERT INTO settings (key, value) VALUES ('ffmpeg_path', ?)
                    ON CONFLICT(key) DO UPDATE SET value = excluded.value
                """, (path,))

    @staticmethod
    def _job(row) -> Job:
        job = dict(row)
        job["details"] = json.loads(job["details"])
        return job

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path)
        connection.row_factory = sqlite3.Row
        return connection

    def create(self, video_id: str, url: str, instrument: str, version: str, *,
               kind: str = "transcribe", song_id: str | None = None,
               metadata: dict | None = None, reuse: bool = True,
               processing_mode: str = "local", transcription_model: str | None = None,
               cloud_provider: str | None = None, cloud_target: dict | None = None) -> Job:
        with closing(self._connect()) as connection, connection:
            connection.execute("BEGIN IMMEDIATE")
            setting = connection.execute(
                "SELECT value FROM settings WHERE key = 'transcription_model'").fetchone()
            model = transcription_model or (setting[0] if setting else "muscriptor-small")
            if kind == "transcribe" and model not in TRANSCRIPTION_MODELS:
                raise InvalidTranscriptionModel()
            if kind == "transcribe":
                active = connection.execute("""
                    SELECT * FROM jobs WHERE video_id = ? AND instrument = ? AND kind = 'transcribe'
                        AND transcription_model = ?
                        AND (song_id IS ? OR (song_id IS NULL AND ? IS NOT NULL))
                        AND status IN ('queued', 'running')
                        AND COALESCE(json_extract(details, '$.processingMode'), 'local') = ?
                        AND COALESCE(json_extract(details, '$.cloudProvider'), 'azure') = ?
                    ORDER BY (song_id IS NULL), created_at LIMIT 1
                """, (video_id, instrument, model, song_id, song_id, processing_mode,
                      cloud_provider if cloud_provider is not None else "azure")).fetchone()
                if active is not None:
                    if song_id and not active["song_id"]:
                        connection.execute("UPDATE jobs SET song_id = ? WHERE id = ?", (song_id, active["id"]))
                        active = connection.execute("SELECT * FROM jobs WHERE id = ?", (active["id"],)).fetchone()
                    return self._job(active)
            if reuse and processing_mode == "local" and kind == "transcribe" and instrument != "auto" and song_id is None:
                cached = connection.execute("""
                    SELECT * FROM jobs WHERE video_id = ? AND instrument = ?
                        AND pipeline_version = ? AND transcription_model = ? AND status = 'done'
                        AND COALESCE(json_extract(details, '$.processingMode'), 'local') = 'local'
                    ORDER BY created_at DESC LIMIT 1
                """, (video_id, instrument, version, model)).fetchone()
                if cached is not None:
                    candidate = self._job(cached)
                    artifacts = candidate["details"].get("artifacts", {})
                    analysis = artifacts.get("analysis")
                    valid = candidate["details"].get("cacheable", True) \
                        and all(Path(path).is_file() for path in artifacts.values())
                    if valid and analysis:
                        try:
                            song = json.loads(Path(analysis).read_text(encoding="utf-8"))
                            valid = all(name in song for name in ("tracks", "piano", "drums", "chords"))
                        except (OSError, ValueError):
                            valid = False
                    if valid:
                        return candidate
            job_id, timestamp = str(uuid4()), now()
            order_index = connection.execute(
                "SELECT COALESCE(MAX(order_index), -1) + 1 FROM jobs WHERE status IN ('queued', 'running')"
            ).fetchone()[0]
            stage = "align" if kind == "align" else "inspect"
            details = {"attemptQueuedAt": timestamp}
            if metadata:
                details["metadata"] = metadata
            if processing_mode == "cloud":
                details["processingMode"] = "cloud"
                if cloud_provider is not None:
                    details["cloudProvider"] = cloud_provider
                if cloud_target is not None:
                    details["cloudTarget"] = cloud_target
            connection.execute("""
                INSERT INTO jobs (id, video_id, url, instrument, kind, song_id, title,
                    thumbnail, stage, status, progress, order_index, dismissed, error_code,
                    error_message, pipeline_version, transcription_model, created_at, updated_at, details)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, 0, NULL, NULL, ?, ?, ?, ?, ?)
            """, (job_id, video_id, url, instrument, kind, song_id,
                  metadata.get("title") if metadata else None,
                  metadata.get("thumbnail") if metadata else None, stage, order_index,
                  version, model, timestamp, timestamp, json.dumps(details, allow_nan=False)))
            return self._job(connection.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone())

    def get(self, job_id: str) -> Job:
        if not isinstance(job_id, str) or not job_id:
            raise JobNotFound()
        with closing(self._connect()) as connection:
            row = connection.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
        if row is None:
            raise JobNotFound()
        return self._job(row)

    def list(self) -> list[Job]:
        with closing(self._connect()) as connection:
            return [self._job(row) for row in connection.execute(
                "SELECT * FROM jobs ORDER BY created_at DESC")]

    def list_queue(self) -> list[Job]:
        cutoff = (datetime.now(timezone.utc) - timedelta(minutes=10)).isoformat()
        with closing(self._connect()) as connection:
            rows = connection.execute("""
                SELECT * FROM jobs WHERE dismissed = 0 AND (
                    status IN ('queued', 'running', 'failed') OR
                    (status IN ('done', 'cancelled') AND updated_at >= ?)
                )
                ORDER BY CASE status WHEN 'running' THEN -1 WHEN 'queued' THEN order_index
                    ELSE 1000000 END, updated_at DESC
            """, (cutoff,))
            return [self._job(row) for row in rows]

    def next_queued(self) -> Job | None:
        with closing(self._connect()) as connection:
            row = connection.execute("""
                SELECT * FROM jobs WHERE status = 'queued'
                ORDER BY order_index, created_at LIMIT 1
            """).fetchone()
        return self._job(row) if row else None

    def queue_order(self, job_id: str) -> int:
        job = self.get(job_id)
        if job["status"] == "running":
            return 0
        if job["status"] != "queued":
            return job["order_index"]
        with closing(self._connect()) as connection:
            running = connection.execute(
                "SELECT COUNT(*) FROM jobs WHERE status = 'running'").fetchone()[0]
            before = connection.execute("""
                SELECT COUNT(*) FROM jobs WHERE status = 'queued' AND
                    (order_index < ? OR (order_index = ? AND created_at < ?))
            """, (job["order_index"], job["order_index"], job["created_at"])).fetchone()[0]
        return running + before

    def update(self, job_id: str, *, status: str | None = None, stage: str | None = None,
               progress: float | None = None, error: MizanError | None = None,
               details: dict | None = None, title: str | None = None,
               thumbnail: str | None = None, dismissed: bool | None = None,
               song_id: str | None = None) -> None:
        with closing(self._connect()) as connection, connection:
            cursor = connection.execute("""
                UPDATE jobs SET status = COALESCE(?, status), stage = COALESCE(?, stage),
                    progress = COALESCE(?, progress), error_code = ?, error_message = ?,
                    updated_at = ?, details = COALESCE(?, details),
                    title = COALESCE(?, title), thumbnail = COALESCE(?, thumbnail),
                    dismissed = COALESCE(?, dismissed), song_id = COALESCE(?, song_id)
                WHERE id = ?
            """, (status, stage, progress, error.code if error else None,
                  str(error) if error else None, now(),
                  json.dumps(details, allow_nan=False) if details is not None else None,
                  title, thumbnail, int(dismissed) if dismissed is not None else None,
                  song_id, job_id))
            if cursor.rowcount != 1:
                raise JobNotFound()

    def move(self, job_id: str, order: int) -> Job:
        if not isinstance(order, int):
            raise MizanError("Queue order must be an integer.")
        job = self.get(job_id)
        if job["status"] != "queued":
            raise MizanError("Only queued jobs can be reordered.")
        with closing(self._connect()) as connection, connection:
            ids = [row[0] for row in connection.execute(
                "SELECT id FROM jobs WHERE status = 'queued' ORDER BY order_index, created_at")]
            ids.remove(job_id)
            ids.insert(max(0, min(order, len(ids))), job_id)
            connection.executemany("UPDATE jobs SET order_index = ?, updated_at = ? WHERE id = ?",
                                   [(index, now(), value) for index, value in enumerate(ids)])
        return self.get(job_id)

    def retry(self, job_id: str, transcription_model: str | None = None) -> Job:
        job = self.get(job_id)
        if job["status"] not in ("failed", "cancelled"):
            raise MizanError("Only failed or cancelled jobs can be retried.")
        model = (_smaller_retry_model(job, transcription_model)
                 if transcription_model is not None else job["transcription_model"])
        with closing(self._connect()) as connection, connection:
            timestamp = now()
            order = connection.execute(
                "SELECT COALESCE(MAX(order_index), -1) + 1 FROM jobs WHERE status IN ('queued', 'running')"
            ).fetchone()[0]
            details = job["details"]
            details["attemptQueuedAt"] = timestamp
            for key in ("startedAt", "finishedAt", "elapsedSeconds", "cloudElapsedSeconds",
                        "stageStartedAt", "timingStage", "stageProgressMeasured", "stageMessage",
                        "activeStage", "diagnostics"):
                details.pop(key, None)
            connection.execute("""
                UPDATE jobs SET transcription_model = ?, status = 'queued', stage = ?, progress = 0,
                    order_index = ?, dismissed = 0, error_code = NULL, error_message = NULL,
                    updated_at = ?, details = ?
                WHERE id = ?
            """, (model, "align" if job["kind"] == "align" else "inspect", order, timestamp,
                  json.dumps(details, allow_nan=False), job_id))
        return self.get(job_id)

    def dismiss(self, job_id: str) -> None:
        job = self.get(job_id)
        if job["status"] in ("queued", "running"):
            raise MizanError("Cancel this job before dismissing it.")
        self.update(job_id, dismissed=True)


def processing_pipeline(job: Job, report: Callable[[str, float], None], cancelled: Event) -> dict:
    if job["kind"] == "align":
        from .alignment import align_recording
        return align_recording(job, report, cancelled, LibraryStore())
    from .engine.pipeline import run_pipeline
    return run_pipeline(job, report, cancelled)


class JobRunner:
    def __init__(self, store: JobStore, pipeline: Pipeline = processing_pipeline,
                 pipeline_version: str | None = None):
        self.store = store
        self.library = LibraryStore(store.path)
        self.pipeline = pipeline
        self.pipeline_version = pipeline_version or (
            f"{PIPELINE_VERSION}:{os.environ.get('MIZAN_BEATS', 'auto')}:"
            f"{os.environ.get('MIZAN_PROVIDER', 'auto')}"
        )
        self._events: dict[str, Event] = {}
        self._lock = Lock()
        self._condition = Condition(self._lock)
        self._closed = False
        self._thread = Thread(target=self._run, name="mizan-jobs", daemon=True)
        self._thread.start()

    def _enqueue(self, video_id: str, url: str, instrument: str, **kwargs) -> Job:
        cloud = False
        cloud_provider = None
        cloud_target = None
        model = self.store.get_transcription_model()
        if kwargs.get("kind", "transcribe") == "transcribe":
            from .cloud import selected
            cloud = selected()
            if cloud:
                from .cloud import require_model, selected_provider
                cloud_provider = selected_provider()
                require_model(model, provider=cloud_provider)
                from .cloud import provider_target
                cloud_target = provider_target(cloud_provider)
            if not cloud:
                from .engine.muscriptor import check_model_resources
                check_model_resources(model)
        with self._condition:
            if self._closed:
                raise MizanError("The job runner has shut down.")
            job = self.store.create(video_id, url, instrument, self.pipeline_version,
                                    processing_mode="cloud" if cloud else "local",
                                    transcription_model=model, cloud_provider=cloud_provider,
                                    cloud_target=cloud_target, **kwargs)
            if job["status"] == "queued":
                self._events.setdefault(job["id"], Event())
                self._condition.notify()
            return job

    def start(self, url: str, instrument: str) -> Job:
        video_id = parse_video_id(url)
        if instrument not in ("piano", "drums"):
            raise InvalidInstrument()
        return self._enqueue(video_id, url, instrument)

    def add_link(self, url: str, metadata: dict | None = None) -> Job:
        video_id = parse_video_id(url)
        canonical = f"https://www.youtube.com/watch?v={video_id}"
        return self._enqueue(video_id, canonical, "auto", metadata=metadata, reuse=False)

    def align(self, song_id: str, url: str, metadata: dict) -> Job:
        video_id = parse_video_id(url)
        self.library.get(song_id)
        canonical = f"https://www.youtube.com/watch?v={video_id}"
        return self._enqueue(video_id, canonical, "auto", kind="align", song_id=song_id,
                             metadata=metadata, reuse=False)

    def reprocess(self, song_id: str) -> Job:
        entry = self.library.get(song_id)
        if entry["source"] != "youtube" or not entry["source_url"]:
            raise MizanError("Only YouTube transcriptions can be reprocessed.")
        video_id = parse_video_id(entry["source_url"])
        metadata = {"title": entry["title"], "thumbnail": entry["thumbnail"],
                    "duration": entry["duration"], "videoId": video_id, "source": entry["source_url"]}
        return self._enqueue(video_id, entry["source_url"], "auto", song_id=song_id,
                             metadata=metadata, reuse=False)

    def cancel(self, job_id: str) -> Job:
        with self._condition:
            job = self.store.get(job_id)
            if job["status"] in ("queued", "running"):
                self._events.setdefault(job_id, Event()).set()
                details = job["details"]
                details["finishedAt"] = now()
                elapsed = _elapsed_seconds(details.get("attemptQueuedAt"), details["finishedAt"])
                if elapsed is None:
                    details.pop("elapsedSeconds", None)
                else:
                    details["elapsedSeconds"] = round(elapsed, 3)
                self.store.update(job_id, status="cancelled", error=Cancelled(), details=details)
                self._condition.notify()
            return self.store.get(job_id)

    def retry(self, job_id: str, transcription_model: str | None = None) -> Job:
        job = self.store.get(job_id)
        if job["kind"] == "transcribe":
            if job["transcription_model"] not in TRANSCRIPTION_MODELS:
                raise InvalidTranscriptionModel()
            if transcription_model is not None:
                _smaller_retry_model(job, transcription_model)
                if job["details"].get("processingMode") == "cloud":
                    raise MizanError("Smaller-model retries are only available for Local jobs.")
            model = transcription_model or job["transcription_model"]
            if job["details"].get("processingMode") != "cloud":
                from .engine.muscriptor import check_model_resources
                check_model_resources(model)
            else:
                if transcription_model is not None:
                    raise MizanError("Smaller-model retries are only available for Local jobs.")
                from .cloud import provider_for_job, validate_provider_target
                provider = provider_for_job(job["details"].get("cloudProvider"))
                target = job["details"].get("cloudTarget")
                if target is not None:
                    validate_provider_target(target, provider)
        with self._condition:
            job = self.store.retry(job_id, transcription_model)
            self._events[job_id] = Event()
            self._condition.notify()
            return job

    def move(self, job_id: str, order: int) -> Job:
        with self._condition:
            job = self.store.move(job_id, order)
            self._condition.notify()
            return job

    def close(self) -> None:
        with self._condition:
            if not self._closed:
                self._closed = True
                for job_id, event in self._events.items():
                    event.set()
                    job = self.store.get(job_id)
                    if job["status"] in ("queued", "running"):
                        details = job["details"]
                        details["finishedAt"] = now()
                        elapsed = _elapsed_seconds(details.get("attemptQueuedAt"), details["finishedAt"])
                        if elapsed is None:
                            details.pop("elapsedSeconds", None)
                        else:
                            details["elapsedSeconds"] = round(elapsed, 3)
                        self.store.update(job_id, status="cancelled", error=Cancelled(), details=details)
                self._condition.notify_all()
        self._thread.join()

    def _run(self) -> None:
        while True:
            with self._condition:
                job = self.store.next_queued()
                while job is None and not self._closed:
                    self._condition.wait()
                    job = self.store.next_queued()
                if self._closed:
                    return
                job_id = job["id"]
                event = self._events.setdefault(job_id, Event())
            try:
                self._execute(job_id, event)
            except Exception:
                logger.exception("Could not persist job state for %s", job_id)
            finally:
                with self._condition:
                    self._events.pop(job_id, None)

    def _execute(self, job_id: str, event: Event) -> None:
        with self._lock:
            queued = self.store.get(job_id)
            if event.is_set() or queued["status"] != "queued":
                return
            details = queued["details"]
            if details.get("processingMode") == "cloud":
                from .cloud import provider_for_job, validate_provider_target
                try:
                    provider = provider_for_job(details.get("cloudProvider"))
                    details["cloudProvider"] = provider
                    target = details.get("cloudTarget")
                    if target is not None:
                        validate_provider_target(target, provider)
                except MizanError as exc:
                    details["finishedAt"] = now()
                    self.store.update(job_id, status="failed", error=exc, details=details)
                    return
            attempt_started_at = now()
            queue_wait = _elapsed_seconds(details.get("attemptQueuedAt"), attempt_started_at)
            execution_started = time.perf_counter()
            details["startedAt"] = attempt_started_at
            for key in ("finishedAt", "elapsedSeconds", "cloudElapsedSeconds",
                        "stageStartedAt", "timingStage", "stageProgressMeasured",
                        "stageMessage", "cloudFiles", "activeStage", "found", "previewArtifacts"):
                details.pop(key, None)
            self.store.update(job_id, status="running", details=details)
            job = self.store.get(job_id)

        def report(stage: str, progress: float, *, measured: bool = False,
                   message: str | None = None, cloud_job: dict | None = None) -> None:
            with self._lock:
                if cloud_job is not None:
                    from .cloud import CloudError, validate_remote_job
                    if job["details"].get("processingMode") != "cloud":
                        raise CloudError("A Local job cannot record a Cloud job identifier.")
                    job["details"]["cloudJob"] = validate_remote_job(
                        cloud_job, job["details"].get("cloudProvider", "azure"))
                    # A remote submission can finish after cancellation was requested.
                    self.store.update(job_id, details=job["details"])
                if event.is_set():
                    raise Cancelled()
                if stage not in ALL_STAGES or not isinstance(progress, (int, float)) \
                        or not math.isfinite(progress) or not 0 <= progress <= 1:
                    raise ValueError("Pipeline progress must use a known stage and a value from 0 to 1.")
                details = job["details"]
                if details.get("timingStage") != stage:
                    details["timingStage"] = stage
                    details["stageStartedAt"] = now()
                    details["stageProgressMeasured"] = False
                if measured:
                    details["stageProgressMeasured"] = True
                if message:
                    details["stageMessage"] = message
                else:
                    details.pop("stageMessage", None)
                metadata = details.get("metadata") or {}
                self.store.update(job_id, stage=stage, progress=progress, details=details,
                                  title=metadata.get("title"), thumbnail=metadata.get("thumbnail"))

        error, result = None, None
        try:
            result = self.pipeline(job, report, event)
        except MizanError as exc:
            error = exc
        except Exception:
            logger.exception("Pipeline failed for job %s", job_id)
            error = MizanError()

        cleanup_names = None
        cloud_provider = (job["details"].get("cloudProvider", "azure")
                          if job["details"].get("processingMode") == "cloud" else None)

        def finished_details(details: dict) -> dict:
            finished_at = now()
            details["finishedAt"] = finished_at
            runtime = time.perf_counter() - execution_started
            elapsed = None if queue_wait is None else queue_wait + runtime
            if elapsed is None:
                details.pop("elapsedSeconds", None)
            else:
                details["elapsedSeconds"] = round(max(0.0, elapsed), 3)
            return details

        with self._lock:
            if event.is_set() or isinstance(error, Cancelled):
                if result and result.get("artifacts") and job["kind"] == "transcribe":
                    from .engine.pipeline import discard_result
                    discard_result(job_id)
                details = finished_details(job["details"])
                self.store.update(job_id, status="cancelled", error=Cancelled(), details=details)
                cleanup_names = job["details"].get("cloudFiles")
            elif error:
                details = finished_details(job["details"])
                self.store.update(job_id, status="failed", error=error, details=details)
                cleanup_names = job["details"].get("cloudFiles")
            else:
                details = {**(job.get("details") or {}), **(result or {})}
                song_id = job["song_id"]
                try:
                    if job["kind"] == "transcribe":
                        completed = {**self.store.get(job_id), "details": details}
                        entry = self.library.upsert_job(completed, self.pipeline_version)
                        if entry:
                            song_id = entry["id"]
                        elif details.get("cloudFiles"):
                            raise MizanError("Cloud output was not saved to the library; remote files were retained.")
                    details = finished_details(details)
                    self.store.update(job_id, status="done", stage="finalize", progress=1,
                                      details=details, song_id=song_id)
                    cleanup_names = details.get("cloudFiles") if song_id else None
                except Exception:
                    logger.exception("Could not save result for job %s", job_id)
                    details = finished_details(details)
                    self.store.update(job_id, status="failed",
                                      error=MizanError("Could not save the song to the library; remote Cloud files were retained."),
                                      details=details)
        if cleanup_names:
            from .cloud import cleanup
            try:
                target = job["details"].get("cloudTarget")
                if target is None:
                    cleanup(cleanup_names, provider=cloud_provider)
                else:
                    cleanup(cleanup_names, provider=cloud_provider, target=target)
            except Exception:
                logger.exception("Cloud files could not be removed after saving job %s", job_id)
            else:
                details = self.store.get(job_id)["details"]
                details.pop("cloudFiles", None)
                self.store.update(job_id, details=details)
