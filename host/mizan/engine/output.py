import math
from pathlib import Path
from xml.etree import ElementTree as ET

import mido

from .accompaniment import generate_accompaniment
from .drums import GM_DRUMS


def quantize(seconds: float, bpm: float, phase: float = 0) -> float:
    beat = seconds * bpm / 60
    phase_beat = phase * bpm / 60
    snapped = round((beat - phase_beat) * 4) / 4 + phase_beat
    return round(max(0.0, snapped if abs(snapped - beat) <= 0.08 else beat), 6)


def build_song(title: str, source: str, duration: float, harmony: dict,
               piano: list[dict], drums: list[dict], diagnostics: dict, *,
               vocals: list[dict] | None = None) -> dict:
    bpm, bars = harmony["bpm"], harmony["bars"]
    beats_per_bar = harmony["beatsPerBar"]
    phase = harmony["timing"]["phaseSeconds"]
    piano_output = []
    for note in piano:
        start = quantize(note["onset"], bpm, phase)
        end = quantize(note["offset"], bpm, phase)
        piano_output.append({**note, "startBeat": start, "beats": round(max(0.01, end - start), 6)})
    drum_output = [{**hit, "startBeat": quantize(hit["onset"], bpm, phase)} for hit in drums]
    vocal_output = [{**note, "startBeat": round(note["onset"] * bpm / 60, 6),
                     "beats": round((note["offset"] - note["onset"]) * bpm / 60, 6)}
                    for note in vocals or []]
    accompaniment = generate_accompaniment(harmony)
    for note in accompaniment:
        note.update(onset=note["startBeat"] * 60 / bpm,
                    offset=(note["startBeat"] + note["beats"]) * 60 / bpm)
    tracks = []
    if piano_output:
        tracks.append({"id": "piano", "instrument": "piano", "name": "Piano",
                       "detail": "Draft two-hand transcription; other pitched instruments may bleed through"})
    if drum_output:
        tracks.append({"id": "drums", "instrument": "drums", "name": "Drum kit",
                       "detail": "Kick-like, snare-like and merged cymbal/hat groups"})
    if vocal_output:
        tracks.append({"id": "vocals", "instrument": "vocals", "name": "Vocal melody",
                       "detail": "Draft dominant vocal line; soft vowel synth, no lyrics"})
    if accompaniment:
        tracks.append({"id": "accompaniment", "instrument": "piano", "name": "Generated accompaniment",
                       "group": "creative",
                       "detail": "Generated from detected harmony, not transcribed from the recording"})

    def confidence(events):
        values = [[] for _ in range(bars)]
        for event in events:
            first = min(bars - 1, math.floor(event["startBeat"] / beats_per_bar))
            last = min(bars - 1, math.floor((event["startBeat"] + event.get("beats", 0) - 1e-8) / beats_per_bar))
            for bar in range(first, max(first, last) + 1):
                values[bar].append(event["confidence"])
        return ["high" if row and sum(row) / len(row) >= 0.8 else
                "medium" if row and sum(row) / len(row) >= 0.5 else "low" for row in values]

    chords = [{**chord, "onset": chord["startBeat"] * 60 / bpm,
               "offset": (chord["startBeat"] + chord["beats"]) * 60 / bpm} for chord in harmony["chords"]]
    return {
        "title": title, "source": source, "bpm": bpm, "beatsPerBar": beats_per_bar,
        "beatUnit": harmony.get("beatUnit", 4), "bars": bars,
        "key": harmony["key"], "sections": harmony["sections"], "chords": chords,
        "piano": piano_output, "drums": drum_output, "vocals": vocal_output,
        "accompaniment": accompaniment, "tracks": tracks,
        "confidence": {"piano": confidence(piano_output), "drums": confidence(drum_output),
                       "vocals": confidence(vocal_output)},
        "durationSeconds": duration, "timing": harmony["timing"],
        "sectionEnergy": harmony["sectionEnergy"], "diagnostics": diagnostics,
        "warnings": harmony["warnings"] + [warning for stage in diagnostics.values()
                                           for warning in stage.get("warnings", [])],
        "draft": True,
    }


def export_midi(song: dict, path: Path) -> None:
    midi = mido.MidiFile(ticks_per_beat=480)
    tempo = mido.MidiTrack()
    tempo.append(mido.MetaMessage("set_tempo", tempo=mido.bpm2tempo(song["bpm"])))
    beat_unit = song.get("beatUnit", 4)
    tempo.append(mido.MetaMessage("time_signature", numerator=round(song["beatsPerBar"] * beat_unit / 4),
                                  denominator=beat_unit))
    midi.tracks.append(tempo)
    fractional = any(
        note["midi"] != int(note["midi"])
        for track in song["tracks"] if track["instrument"] != "drums" and track.get("group") != "detected"
        for note in _track_events(song, track)
    )
    available = [channel for channel in range(3, 16) if channel != 9]
    for track in song["tracks"]:
        if track.get("group") == "detected":
            continue
        events = _track_events(song, track)
        output = mido.MidiTrack()
        output.append(mido.MetaMessage("track_name", name=track["name"]))
        if track["instrument"] == "drums":
            channel = 9
        elif track["id"] == "vocals":
            channel = 2
        elif track["id"] == "accompaniment":
            channel = 1
        elif track.get("gmProgram") in range(128):
            if not available:
                raise ValueError("MIDI export requires more than 12 independent instrument channels.")
            channel = available.pop(0)
        else:
            channel = 0
        program = track.get("gmProgram", 53 if channel == 2 else 0)
        if channel != 9 and not fractional:
            output.append(mido.Message("program_change", channel=channel, program=program))
        messages = []
        active = {}
        owned = []
        for event in sorted(events, key=lambda item: item["startBeat"]):
            start = max(0, round(event["startBeat"] * 480))
            end = start + max(1, round(event.get("beats", 0.1) * 480))
            pitch = GM_DRUMS[event["lane"]] if channel == 9 else event["midi"]
            if fractional and channel != 9:
                channel = next((value for value in owned if active[value] <= start), None)
                if channel is None:
                    if not available:
                        raise ValueError("MIDI export requires more than 12 independent pitch-bend channels.")
                    channel = available.pop(0)
                    owned.append(channel)
                active[channel] = end
                base = math.ceil(pitch - 0.5)
                messages.append((start, 0, mido.Message("pitchwheel", channel=channel,
                                                         pitch=round((pitch - base) * 4096))))
                pitch = base
            else:
                pitch = int(pitch)
            messages.extend([
                (start, 1, mido.Message("note_on", channel=channel, note=pitch,
                                        velocity=max(1, min(127, round(event["velocity"] * 127))))),
                (end, -1, mido.Message("note_off", channel=channel, note=pitch, velocity=0)),
            ])
        if fractional and channel != 9:
            for used in owned:
                output.append(mido.Message("program_change", channel=used,
                                            program=program))
                for control, value in ((101, 0), (100, 0), (6, 2), (38, 0), (101, 127), (100, 127)):
                    output.append(mido.Message("control_change", channel=used, control=control, value=value))
        previous = 0
        for tick, _, message in sorted(messages, key=lambda item: (item[0], item[1])):
            message.time = tick - previous
            output.append(message)
            previous = tick
        midi.tracks.append(output)
    midi.save(path)


def _track_events(song: dict, track: dict) -> list[dict]:
    instrument = track["instrument"]
    if instrument == "other":
        return song.get("instrumentNotes", {}).get(track["id"], [])
    candidates = song[track["id"]] if track["id"] == "accompaniment" else song[
        "drums" if instrument == "drums" else "vocals" if instrument == "vocals" else "piano"]
    if any("trackId" in event for event in candidates):
        if any("trackId" not in event for event in candidates):
            raise ValueError("Cannot export a multi-part score without per-note track attribution.")
        return [event for event in candidates if event["trackId"] == track["id"]]
    if sum(other["instrument"] == instrument and other["id"] != "accompaniment"
           for other in song["tracks"]) > 1:
        raise ValueError("Cannot export a multi-part score without per-note track attribution.")
    return candidates


def export_musicxml(song: dict, path: Path) -> None:
    """Keep all parts and exact beat durations, splitting sustained notes at bar lines."""
    root = ET.Element("score-partwise", version="4.0")
    part_list = ET.SubElement(root, "part-list")
    division = 480
    bar_ticks = round(song["beatsPerBar"] * division)
    for track in song["tracks"]:
        if track.get("group") == "detected":
            continue
        part_id = track["id"]
        score_part = ET.SubElement(part_list, "score-part", id=part_id)
        ET.SubElement(score_part, "part-name").text = track["name"]
        program = track.get("gmProgram")
        if track["instrument"] == "other" and isinstance(program, int) and 0 <= program <= 127:
            instrument_id = f"{part_id}-I1"
            ET.SubElement(ET.SubElement(score_part, "score-instrument", id=instrument_id),
                          "instrument-name").text = track["name"]
            midi_instrument = ET.SubElement(score_part, "midi-instrument", id=instrument_id)
            ET.SubElement(midi_instrument, "midi-channel").text = "1"
            ET.SubElement(midi_instrument, "midi-program").text = str(program + 1)
        part = ET.SubElement(root, "part", id=part_id)
        drum = track["instrument"] == "drums"
        events = [(max(0, round(event["startBeat"] * division)),
                   max(1, round(event.get("beats", 0.1) * division)), event)
                  for event in _track_events(song, track)]
        for bar in range(song["bars"]):
            measure = ET.SubElement(part, "measure", number=str(bar + 1))
            if bar == 0:
                attrs = ET.SubElement(measure, "attributes")
                ET.SubElement(attrs, "divisions").text = str(division)
                time = ET.SubElement(attrs, "time")
                beat_unit = song.get("beatUnit", 4)
                ET.SubElement(time, "beats").text = str(round(song["beatsPerBar"] * beat_unit / 4))
                ET.SubElement(time, "beat-type").text = str(beat_unit)
                clef = ET.SubElement(attrs, "clef")
                ET.SubElement(clef, "sign").text = "percussion" if drum else "G"
                if not drum:
                    ET.SubElement(clef, "line").text = "2"
                direction = ET.SubElement(measure, "direction")
                ET.SubElement(ET.SubElement(direction, "direction-type"), "words").text = "Draft transcription"
                ET.SubElement(direction, "sound", tempo=str(song["bpm"]))
            cursor = 0
            for onset, length, event in sorted(events, key=lambda item: item[0]):
                start = max(onset, bar * bar_ticks)
                end = min(onset + length, (bar + 1) * bar_ticks)
                if end <= start:
                    continue
                position = start - bar * bar_ticks
                if position != cursor:
                    move = ET.SubElement(measure, "forward" if position > cursor else "backup")
                    ET.SubElement(move, "duration").text = str(abs(position - cursor))
                note = ET.SubElement(measure, "note")
                if drum:
                    unpitched = ET.SubElement(note, "unpitched")
                    ET.SubElement(unpitched, "display-step").text = "F" if event["lane"] == "kick" else "C"
                    ET.SubElement(unpitched, "display-octave").text = "4" if event["lane"] == "kick" else "5"
                else:
                    pitch = ET.SubElement(note, "pitch")
                    midi_pitch = event["midi"]
                    base = math.ceil(midi_pitch - 0.5)
                    step, alter = (("C", 0), ("C", 1), ("D", 0), ("D", 1), ("E", 0), ("F", 0),
                                   ("F", 1), ("G", 0), ("G", 1), ("A", 0), ("A", 1), ("B", 0))[base % 12]
                    alter += midi_pitch - base
                    ET.SubElement(pitch, "step").text = step
                    if alter:
                        ET.SubElement(pitch, "alter").text = str(alter)
                    ET.SubElement(pitch, "octave").text = str(base // 12 - 1)
                ET.SubElement(note, "duration").text = str(end - start)
                ties = ([] if onset == start else ["stop"]) + ([] if onset + length == end else ["start"])
                for tie in ties:
                    ET.SubElement(note, "tie", type=tie)
                if ties:
                    notations = ET.SubElement(note, "notations")
                    for tie in ties:
                        ET.SubElement(notations, "tied", type=tie)
                cursor = position + end - start
            if cursor < bar_ticks:
                rest = ET.SubElement(measure, "note")
                ET.SubElement(rest, "rest")
                ET.SubElement(rest, "duration").text = str(bar_ticks - cursor)
    ET.ElementTree(root).write(path, encoding="utf-8", xml_declaration=True)
