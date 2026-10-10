import base64
import binascii
import io
import json
import math
import re
import zipfile
from pathlib import Path
from uuid import uuid4
from xml.etree import ElementTree as ET

import mido
import numpy as np

from .engine.harmony import classify_chord, detect_key, smooth_chords
from .engine.drums import GM_LANES
from .engine.output import export_midi
from .errors import InvalidFile
from .jobs import PIPELINE_VERSION
from .library import LibraryStore
from .meter import build_bar_map, signature_beats, time_at_beat, validate_bar_map
from .paths import app_dir

PIANO_PROGRAMS = set(range(0, 8))
SOUNDFONT_PROGRAMS = set(range(128)) - PIANO_PROGRAMS
GUITAR_NAMES = ("Acoustic Nylon", "Acoustic Steel", "Electric Jazz",
                "Electric Clean", "Electric Muted", "Overdriven", "Distortion", "Guitar Harmonics")


def _lane(pitch: int) -> str:
    if pitch in GM_LANES:
        return GM_LANES[pitch]
    nearest = min(GM_LANES, key=lambda value: abs(value - pitch))
    return GM_LANES[nearest]


def _track_id(name: str, index: int) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return slug or f"part-{index + 1}"


def parse_midi(data: bytes) -> tuple[str | None, float, float, int, list[dict]]:
    try:
        midi = mido.MidiFile(file=io.BytesIO(data))
    except (OSError, EOFError, ValueError) as exc:
        raise InvalidFile("The MIDI file is damaged or unsupported.") from exc
    bpm, beats_per_bar, beat_unit = 120.0, 4.0, 4
    tempos = {0: 500000}
    meter_changes = []
    names = [None] * len(midi.tracks)
    notes_by_track = [[] for _ in midi.tracks]
    events = []
    end_tick = 0
    for track_index, track in enumerate(midi.tracks):
        tick = 0
        for index, message in enumerate(track):
            tick += message.time
            events.append((tick, track_index, index, message))
        end_tick = max(end_tick, tick)
    programs, bends, active = {}, {}, {}
    rpn, bend_range = {}, {}
    for tick, track_index, _, message in sorted(events, key=lambda event: event[:3]):
        channel = getattr(message, "channel", None)
        if message.type == "track_name":
            names[track_index] = message.name.strip() or None
        elif message.type == "set_tempo":
            if message.tempo <= 0:
                raise InvalidFile("The MIDI file has an invalid tempo.")
            tempos[tick] = message.tempo
        elif message.type == "time_signature":
            current = (message.numerator, message.denominator)
            try:
                signature_beats(*current)
            except ValueError as exc:
                raise InvalidFile(str(exc)) from exc
            position = tick / midi.ticks_per_beat
            change = {"startBeat": position, "numerator": current[0], "denominator": current[1]}
            if meter_changes and meter_changes[-1]["startBeat"] == position:
                if meter_changes[-1] != change:
                    raise InvalidFile("Conflicting time signatures occur at the same MIDI position.")
            else:
                meter_changes.append(change)
        elif message.type == "program_change":
            programs[channel] = message.program
        elif message.type == "control_change" and message.control in (101, 100):
            parameter = list(rpn.get(channel, (127, 127)))
            parameter[0 if message.control == 101 else 1] = message.value
            rpn[channel] = tuple(parameter)
        elif message.type == "control_change" and message.control in (6, 38) and rpn.get(channel) == (0, 0):
            if any(key[0] == channel and starts for key, starts in active.items()):
                raise InvalidFile("Changing MIDI pitch-bend range during held notes is not supported.")
            current = list(bend_range.get(channel, (2, 0)))
            current[0 if message.control == 6 else 1] = message.value
            if current[1] > 99:
                raise InvalidFile("The MIDI pitch-bend range is invalid.")
            bend_range[channel] = tuple(current)
        elif message.type == "pitchwheel":
            if channel != 9 and message.pitch != bends.get(channel, 0) and any(
                key[0] == channel and starts for key, starts in active.items()
            ):
                raise InvalidFile("Changing MIDI pitch bends during held notes are not supported.")
            bends[channel] = message.pitch
        elif message.type == "note_on" and message.velocity > 0:
            semitones, cents = bend_range.get(channel, (2, 0))
            offset = bends.get(channel, 0) / 8192 * (semitones + cents / 100) if channel != 9 else 0
            active.setdefault((channel, message.note), []).append(
                (tick, message.velocity, offset, track_index, programs.get(channel)))
        elif message.type in ("note_off", "note_on"):
            starts = active.get((channel, message.note))
            if starts:
                start, velocity, offset, owner, program = starts.pop(0)
                notes_by_track[owner].append(
                    {"midi": message.note + offset, "startBeat": start / midi.ticks_per_beat,
                     "beats": max(1 / 64, (tick - start) / midi.ticks_per_beat),
                     "velocity": velocity / 127, "channel": channel, "program": program})
    parts = []
    for track_index, notes in enumerate(notes_by_track):
        if not notes:
            continue
        drum_notes = [note for note in notes if note["channel"] == 9]
        if drum_notes:
            parts.append({"name": names[track_index] or "Drum kit", "drums": True, "notes": drum_notes})
        notes = [note for note in notes if note["channel"] != 9]
        if not notes:
            continue
        program = next((note["program"] for note in notes
                        if note["program"] in PIANO_PROGRAMS), None)
        part_name = names[track_index] or (
            "Piano" if program in PIANO_PROGRAMS else f"Track {track_index + 1}")
        other_notes = [note for note in notes if note["program"] not in SOUNDFONT_PROGRAMS]
        if other_notes:
            parts.append({"name": part_name, "drums": False, "notes": other_notes})
        instruments = {}
        for note in notes:
            if note["program"] in SOUNDFONT_PROGRAMS:
                instruments.setdefault(note["program"], []).append(note)
        for gm_program, instrument_notes in instruments.items():
            name = names[track_index] or f"Track {track_index + 1}"
            if 24 <= gm_program <= 31:
                name = f"{name} - {GUITAR_NAMES[gm_program - 24]}"
            else:
                name = f"{name} - GM program {gm_program + 1}"
            parts.append({"name": name, "drums": False,
                          "notes": instrument_notes, "gmProgram": gm_program})
    if not parts:
        raise InvalidFile("The MIDI file contains no notes.")
    bpm = round(mido.tempo2bpm(tempos[0]), 3)
    tempo_map = []
    last_tick, elapsed, tempo = 0, 0.0, tempos[0]
    for tick, next_tempo in sorted(tempos.items()):
        elapsed += mido.tick2second(tick - last_tick, midi.ticks_per_beat, tempo)
        tempo_map.append({"beat": tick / midi.ticks_per_beat, "time": elapsed})
        last_tick, tempo = tick, next_tempo
    # Keep a final segment even when the last tempo change occurs at the end of the file.
    final_tick = max(end_tick, last_tick + midi.ticks_per_beat)
    tempo_map.append({"beat": final_tick / midi.ticks_per_beat,
                      "time": elapsed + mido.tick2second(final_tick - last_tick, midi.ticks_per_beat, tempo)})
    parts[0]["tempoMap"] = tempo_map
    if meter_changes:
        if meter_changes[0]["startBeat"] > 0:
            meter_changes.insert(0, {"startBeat": 0, "numerator": 4, "denominator": 4})
        first = meter_changes[0]
        beat_unit = first["denominator"]
        beats_per_bar = signature_beats(first["numerator"], beat_unit)
        parts[0]["meterChanges"] = meter_changes
    parts[0]["endBeat"] = end_tick / midi.ticks_per_beat
    return None, bpm, beats_per_bar, beat_unit, parts


def _xml_bytes(data: bytes, suffix: str) -> bytes:
    if suffix != ".mxl":
        return data
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            container = ET.fromstring(archive.read("META-INF/container.xml"))
            rootfile = next(element for element in container.iter() if element.tag.endswith("rootfile"))
            path = rootfile.attrib["full-path"]
            if path.startswith("/") or ".." in Path(path).parts:
                raise InvalidFile("The compressed MusicXML file has an unsafe score path.")
            return archive.read(path)
    except (KeyError, StopIteration, ET.ParseError, zipfile.BadZipFile) as exc:
        raise InvalidFile("The compressed MusicXML file is damaged.") from exc


def _child(element, name: str):
    return next((item for item in element if item.tag.rsplit("}", 1)[-1] == name), None)


def _text(element, path: list[str], default=None):
    current = element
    for name in path:
        current = _child(current, name)
        if current is None:
            return default
    return current.text if current.text is not None else default


def parse_musicxml(data: bytes, suffix: str) -> tuple[str | None, float, float, int, list[dict]]:
    try:
        root = ET.fromstring(_xml_bytes(data, suffix))
    except ET.ParseError as exc:
        raise InvalidFile("The MusicXML file is damaged.") from exc
    title = _text(root, ["work", "work-title"]) or _text(root, ["movement-title"])
    names = {}
    programs = {}
    part_list = _child(root, "part-list")
    if part_list is not None:
        for score_part in part_list:
            if score_part.tag.endswith("score-part"):
                names[score_part.attrib.get("id")] = _text(score_part, ["part-name"], "Part")
                try:
                    program = int(_text(score_part, ["midi-instrument", "midi-program"], "0")) - 1
                except (TypeError, ValueError) as exc:
                    raise InvalidFile("The MusicXML instrument program is invalid.") from exc
                if program in SOUNDFONT_PROGRAMS:
                    programs[score_part.attrib.get("id")] = program
    bpm, beats_per_bar, beat_unit, parts = 120.0, 4.0, 4, []
    score_bars = None
    steps = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
    for index, part in enumerate(item for item in root if item.tag.endswith("part")):
        divisions, cursor, last_start, notes = 1, 0.0, 0.0, []
        measure_start = 0.0
        local_numerator, local_unit = 4, 4
        part_bars = []
        ties = {}
        part_name = names.get(part.attrib.get("id"), f"Part {index + 1}")
        percussion = "drum" in part_name.lower() or "percussion" in part_name.lower()
        for measure_index, measure in enumerate(part):
            cursor = measure_start
            measure_end = cursor
            for item in measure:
                tag = item.tag.rsplit("}", 1)[-1]
                if tag == "attributes":
                    divisions = int(_text(item, ["divisions"], divisions))
                    beats = _text(item, ["time", "beats"])
                    beat_type = _text(item, ["time", "beat-type"])
                    if beats and beat_type:
                        try:
                            current = (sum(int(value) for value in beats.split("+")), int(beat_type))
                            signature_beats(*current)
                        except (TypeError, ValueError) as exc:
                            raise InvalidFile("The MusicXML time signature is invalid.") from exc
                        local_numerator, local_unit = current
                elif tag == "direction":
                    sound = next((node for node in item.iter() if node.tag.endswith("sound")), None)
                    if sound is not None and sound.attrib.get("tempo"):
                        bpm = float(sound.attrib["tempo"])
                    per_minute = next((node for node in item.iter() if node.tag.endswith("per-minute")), None)
                    if per_minute is not None and per_minute.text:
                        bpm = float(per_minute.text)
                elif tag in ("backup", "forward"):
                    duration = float(_text(item, ["duration"], 0)) / divisions
                    cursor += duration if tag == "forward" else -duration
                    measure_end = max(measure_end, cursor)
                elif tag == "note":
                    duration = float(_text(item, ["duration"], 0)) / divisions
                    chord = _child(item, "chord") is not None
                    start = last_start if chord else cursor
                    last_start = start
                    if _child(item, "rest") is None:
                        unpitched = _child(item, "unpitched")
                        pitch = _child(item, "pitch")
                        node = unpitched or pitch
                        step = _text(node, ["display-step"] if unpitched is not None else ["step"], "C")
                        octave = int(_text(node, ["display-octave"] if unpitched is not None else ["octave"], 4))
                        try:
                            alter = float(_text(node, ["alter"], 0)) if pitch is not None else 0
                        except (TypeError, ValueError) as exc:
                            raise InvalidFile("The MusicXML pitch alteration is invalid.") from exc
                        if not math.isfinite(alter):
                            raise InvalidFile("The MusicXML pitch alteration is invalid.")
                        midi = 12 * (octave + 1) + steps[step] + alter
                        tie_types = {node.attrib.get("type") for node in item
                                     if node.tag.rsplit("}", 1)[-1] == "tie"}
                        key = (midi, _text(item, ["voice"], "1"))
                        if "stop" in tie_types:
                            if key not in ties:
                                raise InvalidFile("The MusicXML score contains a tie without a starting note.")
                            ties[key]["beats"] += duration
                            if "start" not in tie_types:
                                del ties[key]
                        else:
                            event = {"midi": midi, "startBeat": start, "beats": max(1 / 64, duration),
                                     "velocity": 0.8, "channel": 9 if unpitched is not None else 0}
                            notes.append(event)
                            if "start" in tie_types:
                                ties[key] = event
                        percussion = percussion or unpitched is not None
                    if not chord:
                        cursor += duration
                    measure_end = max(measure_end, start + duration)
            nominal = signature_beats(local_numerator, local_unit)
            length = (measure_end - measure_start
                      if measure.attrib.get("implicit") == "yes" and measure_end > measure_start else nominal)
            part_bars.append({
                "startBeat": round(measure_start, 6), "beats": round(length, 6),
                "numerator": local_numerator, "denominator": local_unit, "status": "explicit",
                **({"partial": True} if length < nominal - 1e-6 else {}),
            })
            measure_start += length
        if ties:
            raise InvalidFile("The MusicXML score contains a tie without an ending note.")
        if notes:
            try:
                validate_bar_map(part_bars)
            except ValueError as exc:
                raise InvalidFile(str(exc)) from exc
            if score_bars is None:
                score_bars = part_bars
            elif score_bars != part_bars:
                raise InvalidFile("MusicXML parts have conflicting measure lengths or time signatures.")
            part_value = {"name": part_name, "drums": percussion, "notes": notes}
            if not percussion and part.attrib.get("id") in programs:
                part_value["gmProgram"] = programs[part.attrib.get("id")]
            parts.append(part_value)
    if not parts:
        raise InvalidFile("The MusicXML file contains no notes.")
    parts[0]["barMap"] = score_bars
    beats_per_bar = signature_beats(score_bars[0]["numerator"], score_bars[0]["denominator"])
    beat_unit = score_bars[0]["denominator"]
    return title, bpm, beats_per_bar, beat_unit, parts


def notes_to_song(title: str, source: str, bpm: float, beats_per_bar: float,
                  beat_unit: int, parts: list[dict]) -> dict:
    piano, drums, tracks, pitched, instrument_notes = [], [], [], [], {}
    extent = parts[0].get("endBeat", 0)
    if type(extent) not in (int, float) or not math.isfinite(extent) or extent < 0:
        raise InvalidFile("The imported score has an invalid end position.")
    max_beat = float(extent)
    tempo_map = parts[0].get("tempoMap")
    for index, part in enumerate(parts):
        track_id = _track_id(part["name"], index)
        suffix = 2
        while any(track["id"] == track_id for track in tracks):
            track_id = f"{_track_id(part['name'], index)}-{suffix}"
            suffix += 1
        if part["drums"]:
            tracks.append({"id": track_id, "instrument": "drums", "name": part["name"],
                           "detail": "Imported percussion part"})
            for note in part["notes"]:
                drums.append({"trackId": track_id, "lane": _lane(note["midi"]), "startBeat": round(note["startBeat"], 6),
                              "velocity": round(note["velocity"], 4), "sourceMidi": int(note["midi"])})
                max_beat = max(max_beat, note["startBeat"] + note["beats"])
        else:
            soundfont = part.get("gmProgram") in SOUNDFONT_PROGRAMS
            tracks.append({"id": track_id, "instrument": "other" if soundfont else "piano",
                           "name": part["name"], "detail": "Imported MIDI instrument" if soundfont
                           else "Imported pitched part",
                           **({"gmProgram": part["gmProgram"]} if soundfont else {})})
            for note in part["notes"]:
                event = {"trackId": track_id, "midi": note["midi"], "startBeat": round(note["startBeat"], 6),
                         "beats": round(note["beats"], 6),
                         "hand": note.get("hand", "left" if note["midi"] < 60 else "right"),
                         "velocity": round(note["velocity"], 4)}
                if soundfont:
                    instrument_notes.setdefault(track_id, []).append(
                        {key: value for key, value in event.items() if key != "hand"})
                else:
                    piano.append(event)
                pitched.append(event)
                max_beat = max(max_beat, note["startBeat"] + note["beats"])
    bar_map = parts[0].get("barMap")
    if bar_map is not None:
        validate_bar_map(bar_map)
        if max_beat > bar_map[-1]["startBeat"] + bar_map[-1]["beats"] + 1e-6:
            raise InvalidFile("The imported notes extend beyond their measure timeline.")
    else:
        changes = parts[0].get("meterChanges") or [
            {"startBeat": 0, "numerator": round(beats_per_bar * beat_unit / 4), "denominator": beat_unit}
        ]
        bar_map = build_bar_map(max(1e-6, max_beat), changes)
    bars = len(bar_map)
    beat_chroma = np.zeros((max(1, math.ceil(max_beat)), 12))
    for note in pitched:
        first, last = int(note["startBeat"]), max(int(note["startBeat"]), math.ceil(note["startBeat"] + note["beats"]) - 1)
        beat_chroma[first:last + 1, round(note["midi"]) % 12] += note["beats"]
    key = detect_key(beat_chroma)
    chords = []
    for beat, vector in enumerate(beat_chroma):
        chord = classify_chord(vector, float(vector.sum()), key)
        chords.append({"startBeat": float(beat), "beats": 1.0,
                       "onset": time_at_beat(tempo_map, bpm, beat), "offset": time_at_beat(tempo_map, bpm, beat + 1),
                       **chord})
    chords = [
        {**chord, "onset": time_at_beat(tempo_map, bpm, chord["startBeat"]),
         "offset": time_at_beat(tempo_map, bpm, chord["startBeat"] + chord["beats"])}
        for chord in smooth_chords(chords)
    ]
    sections = [{"name": f"Part {chr(65 + index)}", "startBar": first + 1,
                 "bars": min(8, bars - first)}
                for index, first in enumerate(range(0, bars, 8))]
    confidence = ["high"] * bars
    return {
        "title": title, "source": source, "bpm": bpm, "beatsPerBar": beats_per_bar, "beatUnit": beat_unit,
        "barMap": bar_map,
        **({"tempoMap": tempo_map} if tempo_map else {}),
        "bars": bars, "key": key, "sections": sections, "chords": chords,
        "piano": sorted(piano, key=lambda note: (note["startBeat"], note["midi"])),
        **({"instrumentNotes": instrument_notes} if instrument_notes else {}),
        "drums": sorted(drums, key=lambda hit: hit["startBeat"]), "tracks": tracks,
        "confidence": {"piano": confidence, "drums": confidence, "chords": confidence},
        "recording": False, "draft": False,
    }


def import_score(name: str, data_base64: str, library: LibraryStore,
                 pipeline_version: str = PIPELINE_VERSION,
                 entry_metadata: dict | None = None) -> dict:
    if not isinstance(name, str) or not isinstance(data_base64, str):
        raise InvalidFile()
    suffix = Path(name).suffix.lower()
    if suffix not in (".mid", ".midi", ".musicxml", ".xml", ".mxl"):
        raise InvalidFile("Supported files are .mid, .midi, .musicxml, .xml and .mxl.")
    try:
        data = base64.b64decode(data_base64, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise InvalidFile("The imported file data is not valid base64.") from exc
    if not data:
        raise InvalidFile("The imported file is empty.")
    parsed_title, bpm, beats_per_bar, beat_unit, parts = (
        parse_midi(data) if suffix in (".mid", ".midi") else parse_musicxml(data, suffix)
    )
    hands = {"up": "right", "down": "left", "right hand": "right", "left hand": "left"}
    if (len(parts) == 2 and not any(part["drums"] for part in parts)
            and {hands.get(part["name"].strip().lower()) for part in parts} == {"left", "right"}):
        parts = [{**{key: parts[0][key] for key in ("barMap", "meterChanges", "endBeat", "tempoMap") if key in parts[0]},
                  "name": "Piano", "drums": False, "notes": [
            {**note, "hand": hands[part["name"].strip().lower()]}
            for part in parts for note in part["notes"]
        ]}]
    title = parsed_title or (entry_metadata or {}).get("title") or Path(name).stem
    source = "midi" if suffix in (".mid", ".midi") else "musicxml"
    song = notes_to_song(title, source, bpm, beats_per_bar, beat_unit, parts)
    song_id = str(uuid4())
    directory = app_dir("cache") / song_id
    directory.mkdir()
    original = directory / ("original" + suffix)
    analysis = directory / "analysis.json"
    original.write_bytes(data)
    analysis.write_text(json.dumps(song, ensure_ascii=True, allow_nan=False), encoding="utf-8")
    artifacts = {"analysis": str(analysis), source: str(original)}
    if source == "musicxml":
        export_midi(song, directory / "score.mid")
        artifacts["midi"] = str(directory / "score.mid")
    return library.create_import(
        title, source, song, artifacts, pipeline_version, song_id, entry_metadata=entry_metadata,
    )
