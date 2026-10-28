import math
from pathlib import Path
from xml.etree import ElementTree as ET

import mido

from ..meter import bar_index, beat_at_time, song_bar_map, time_at_beat
from .accompaniment import generate_accompaniment
from .drums import GM_DRUMS, gm_pitch
from .gm import GM_PROGRAM_NAMES


DETECTED_GM_PROGRAMS = {name: program for program, name in enumerate(GM_PROGRAM_NAMES)}
DETECTED_GM_PROGRAMS.update({"clean_electric_guitar": 27})


def detected_gm_program(instrument: str) -> int | None:
    if instrument.startswith("program_") and instrument[8:].isdigit():
        program = int(instrument[8:])
        return program if 0 <= program <= 127 else None
    return DETECTED_GM_PROGRAMS.get(instrument)


def _valid_gm_program(track: dict) -> int | None:
    program = track.get("gmProgram")
    return program if type(program) is int and 0 <= program <= 127 else None


def _resolved_gm_program(track: dict) -> int | None:
    program = _valid_gm_program(track)
    if program is not None:
        return program
    source_instrument = track.get("sourceInstrument")
    return detected_gm_program(source_instrument) if type(source_instrument) is str else None


def exportable_track(track: dict) -> bool:
    if track.get("group") != "detected":
        return True
    correction = track.get("instrumentCorrection")
    if (track.get("instrument") == "other" and isinstance(correction, dict) and
            type(correction.get("gmProgram")) is int and
            0 <= correction["gmProgram"] < len(GM_PROGRAM_NAMES) and
            _valid_gm_program(track) == correction["gmProgram"]):
        return True
    source_instrument = track.get("sourceInstrument")
    return (track.get("instrument") == "other" and type(source_instrument) is str and
            detected_gm_program(source_instrument) is not None and _resolved_gm_program(track) is not None)


def quantize(seconds: float, bpm: float, phase: float = 0, tempo_map: list[dict] | None = None) -> float:
    if tempo_map:
        beat = beat_at_time(tempo_map, bpm, seconds)
        snapped = round(beat * 4) / 4
        return round(max(0.0, snapped if abs(snapped - beat) <= 0.08 else beat), 6)
    beat = seconds * bpm / 60
    phase_beat = phase * bpm / 60
    snapped = round((beat - phase_beat) * 4) / 4 + phase_beat
    return round(max(0.0, snapped if abs(snapped - beat) <= 0.08 else beat), 6)


def build_song(title: str, source: str, duration: float, harmony: dict,
               piano: list[dict], drums: list[dict], diagnostics: dict, *,
               vocals: list[dict] | None = None) -> dict:
    bpm, bars = harmony["bpm"], harmony["bars"]
    beats_per_bar = harmony["beatsPerBar"]
    bar_map = song_bar_map(harmony)
    phase = harmony["timing"]["phaseSeconds"]
    tempo_map = harmony.get("tempoMap")
    piano_output = []
    for note in piano:
        start = quantize(note["onset"], bpm, phase, tempo_map)
        end = quantize(note["offset"], bpm, phase, tempo_map)
        piano_output.append({**note, "startBeat": start, "beats": round(max(0.01, end - start), 6)})
    drum_output = [{**hit, "startBeat": quantize(hit["onset"], bpm, phase, tempo_map)} for hit in drums]
    vocal_output = []
    for note in vocals or []:
        if not tempo_map:
            vocal_output.append({**note, "startBeat": round(note["onset"] * bpm / 60, 6),
                                 "beats": round((note["offset"] - note["onset"]) * bpm / 60, 6)})
            continue
        start = max(0.0, beat_at_time(tempo_map, bpm, note["onset"]))
        end = max(start + 0.01, beat_at_time(tempo_map, bpm, note["offset"]))
        vocal_output.append({**note, "startBeat": round(start, 6), "beats": round(end - start, 6)})
    accompaniment = generate_accompaniment(harmony)
    for note in accompaniment:
        note.update(onset=time_at_beat(tempo_map, bpm, note["startBeat"]),
                    offset=time_at_beat(tempo_map, bpm, note["startBeat"] + note["beats"]))
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
            first = bar_index(bar_map, event["startBeat"])
            last = bar_index(bar_map, event["startBeat"] + event.get("beats", 0) - 1e-8)
            for bar in range(first, max(first, last) + 1):
                values[bar].append(event["confidence"])
        return ["high" if row and sum(row) / len(row) >= 0.8 else
                "medium" if row and sum(row) / len(row) >= 0.5 else "low" for row in values]

    chords = [{**chord, "onset": time_at_beat(tempo_map, bpm, chord["startBeat"]),
               "offset": time_at_beat(tempo_map, bpm, chord["startBeat"] + chord["beats"])}
              for chord in harmony["chords"]]
    return {
        "title": title, "source": source, "bpm": bpm, "beatsPerBar": beats_per_bar,
        "beatUnit": harmony.get("beatUnit", 4), "bars": bars,
        **({"barMap": bar_map} if "barMap" in harmony else {}),
        **({"tempoMap": tempo_map} if tempo_map else {}),
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


def tempo_changes(song: dict) -> list[tuple[float, float]]:
    """(score beat, quarter BPM) from beat zero, following the recording's tempo map when present."""
    points = song.get("tempoMap") or []
    changes = [(0.0, float(song["bpm"]))]
    for left, right in zip(points, points[1:]):
        if right["beat"] <= 0:
            continue
        bpm = 60 * (right["beat"] - left["beat"]) / (right["time"] - left["time"])
        start = max(0.0, left["beat"])
        if start == changes[-1][0]:
            changes[-1] = (start, bpm)
        elif not math.isclose(bpm, changes[-1][1], rel_tol=1e-6):
            changes.append((start, bpm))
    return changes


def _pitch_bend_plan(event: dict, ticks_per_beat: int) -> dict:
    start = max(0, round(event["startBeat"] * ticks_per_beat))
    end = max(start + 1, round((event["startBeat"] + event.get("beats", 0.1)) * ticks_per_beat))
    pitch = event["midi"]
    if type(pitch) not in (int, float) or not math.isfinite(pitch):
        raise ValueError("A MIDI note has an invalid pitch.")
    base = math.ceil(pitch - 0.5)
    points = [(start, pitch - base)]
    bends = event.get("pitchBends", [])
    if not isinstance(bends, list):
        raise ValueError("A MIDI pitch-bend curve is invalid.")
    for point in bends:
        if (not isinstance(point, dict) or type(point.get("beat")) not in (int, float)
                or type(point.get("semitones")) not in (int, float)
                or not math.isfinite(point["beat"]) or not math.isfinite(point["semitones"])
                or point["beat"] < 0 or point["beat"] >= event.get("beats", 0.1)):
            raise ValueError("A MIDI pitch-bend curve is invalid.")
        tick = start + round(point["beat"] * ticks_per_beat)
        if tick < end:
            points.append((tick, pitch - base + point["semitones"]))
    collapsed = []
    for tick, value in points:
        if collapsed and collapsed[-1][0] == tick:
            collapsed[-1] = (tick, value)
        else:
            collapsed.append((tick, value))
    return {"start": start, "end": end, "base": base, "points": collapsed,
            "hasBends": bool(bends) or pitch != base}


def _bend_at(plan: dict, tick: int) -> float:
    value = plan["points"][0][1]
    for point_tick, point_value in plan["points"][1:]:
        if point_tick > tick:
            break
        value = point_value
    return value


def _compatible_bend_plans(left: dict, right: dict) -> bool:
    start, end = max(left["start"], right["start"]), min(left["end"], right["end"])
    if start >= end:
        return True
    changes = {start}
    changes.update(tick for tick, _ in left["points"] if start < tick < end)
    changes.update(tick for tick, _ in right["points"] if start < tick < end)
    return all(math.isclose(_bend_at(left, tick), _bend_at(right, tick), abs_tol=1e-7)
               for tick in changes)


def _export_pitch_bent_midi(midi: mido.MidiFile, song: dict, available: list[int]) -> None:
    reserved = set()
    for track in song["tracks"]:
        if not exportable_track(track) or track["instrument"] == "drums":
            continue
        if track["id"] == "vocals":
            reserved.add(2)
        elif track["id"] == "accompaniment":
            reserved.add(1)
        elif _resolved_gm_program(track) is None:
            reserved.add(0)
    free_channels = [channel for channel in available if channel not in reserved]
    free_channels.extend(channel for channel in (0, 1, 2) if channel not in reserved)
    channel_programs = {}
    channel_plans = {}
    outputs = []
    end_tick = round((song_bar_map(song)[-1]["startBeat"] + song_bar_map(song)[-1]["beats"])
                     * midi.ticks_per_beat)

    for track in song["tracks"]:
        if not exportable_track(track):
            continue
        events = _track_events(song, track)
        output = mido.MidiTrack()
        output.append(mido.MetaMessage("track_name", name=track["name"]))
        gm_program = _resolved_gm_program(track)
        if track["instrument"] == "drums":
            preferred = 9
            program = 0
        elif track["id"] == "vocals":
            preferred = 2
            program = 53
        elif track["id"] == "accompaniment":
            preferred = 1
            program = 0
        elif gm_program is not None:
            if not free_channels:
                raise ValueError("MIDI pitch-bend export exceeds the available melodic channels.")
            preferred = free_channels.pop(0)
            program = gm_program
        else:
            program = 0
            if 0 in channel_programs:
                if not free_channels:
                    raise ValueError("MIDI pitch-bend export exceeds the available melodic channels.")
                preferred = free_channels.pop(0)
            else:
                preferred = 0
        if preferred != 9:
            if preferred in channel_programs and channel_programs[preferred] != program:
                if not free_channels:
                    raise ValueError("MIDI pitch-bend export exceeds the available melodic channels.")
                preferred = free_channels.pop(0)
            channel_programs[preferred] = program

        messages = []
        used = set()
        owned = [preferred] if preferred != 9 else []
        for event in sorted(events, key=lambda item: item["startBeat"]):
            if preferred == 9:
                start = max(0, round(event["startBeat"] * midi.ticks_per_beat))
                end = max(start + 1, round((event["startBeat"] + event.get("beats", 0.1))
                                           * midi.ticks_per_beat))
                pitch = gm_pitch(event)
                messages.extend([
                    (start, 1, mido.Message("note_on", channel=9, note=pitch,
                                            velocity=max(1, min(127, round(event["velocity"] * 127))))),
                    (end, -1, mido.Message("note_off", channel=9, note=pitch, velocity=0)),
                ])
                continue

            plan = _pitch_bend_plan(event, midi.ticks_per_beat)
            channel = next((candidate for candidate in owned
                            if all(_compatible_bend_plans(plan, other)
                                   for other in channel_plans.get(candidate, []))), None)
            if channel is None:
                if not free_channels:
                    raise ValueError(
                        "Pitch-bend export needs more than the 15 available melodic MIDI channels "
                        "to preserve simultaneous independent bends."
                    )
                channel = free_channels.pop(0)
                owned.append(channel)
                channel_programs[channel] = program
            channel_programs[channel] = program
            channel_plans.setdefault(channel, []).append(plan)
            used.add(channel)
            for tick, semitones in plan["points"]:
                messages.append((tick, 0, (channel, semitones)))
            messages.extend([
                (plan["start"], 1, mido.Message("note_on", channel=channel, note=plan["base"],
                                                velocity=max(1, min(127, round(event["velocity"] * 127))))),
                (plan["end"], -1, mido.Message("note_off", channel=channel, note=plan["base"], velocity=0)),
            ])

        if preferred == 9:
            used.add(9)
        outputs.append((output, messages, used))

    channel_ranges = {}
    for channel, plans in channel_plans.items():
        if any(plan["hasBends"] for plan in plans):
            max_offset = max(abs(value) for plan in plans for _, value in plan["points"])
            range_cents = max(200, math.ceil(max_offset * 100 - 1e-9))
            if range_cents > 12799:
                raise ValueError("MIDI pitch-bend range exceeds the format's 127-semitone limit.")
            channel_ranges[channel] = (range_cents // 100, range_cents % 100)

    for output, messages, used in outputs:
        for channel in sorted(used):
            if channel == 9:
                continue
            output.append(mido.Message("program_change", channel=channel, program=channel_programs[channel]))
            if channel in channel_ranges:
                semitones, cents = channel_ranges[channel]
                for control, value in ((101, 0), (100, 0), (6, semitones), (38, cents),
                                       (101, 127), (100, 127)):
                    output.append(mido.Message("control_change", channel=channel, control=control, value=value))
        previous = 0
        for tick, priority, message in sorted(messages, key=lambda item: (item[0], item[1])):
            if isinstance(message, tuple):
                channel, semitones = message
                semitones_range, cents = channel_ranges.get(channel, (2, 0))
                full_range = semitones_range + cents / 100
                wheel = max(-8192, min(8191, round(semitones / full_range * 8192)))
                message = mido.Message("pitchwheel", channel=channel, pitch=wheel)
            message.time = tick - previous
            output.append(message)
            previous = tick
        output.append(mido.MetaMessage("end_of_track", time=max(0, end_tick - previous)))
        midi.tracks.append(output)


def export_midi(song: dict, path: Path) -> None:
    midi = mido.MidiFile(ticks_per_beat=480)
    tempo = mido.MidiTrack()
    bar_map = song_bar_map(song)
    end_tick = round((bar_map[-1]["startBeat"] + bar_map[-1]["beats"]) * midi.ticks_per_beat)
    # Tempo follows the recording map, so simple and compound passages keep their real speed.
    meta = [(round(beat * midi.ticks_per_beat), 0, mido.MetaMessage("set_tempo", tempo=mido.bpm2tempo(bpm)))
            for beat, bpm in tempo_changes(song)]
    previous_signature, previous_bar = None, None
    for bar in bar_map:
        signature = (bar["numerator"], bar["denominator"])
        if signature != previous_signature or previous_bar is not None and previous_bar.get("partial"):
            meta.append((round(bar["startBeat"] * midi.ticks_per_beat), 1,
                         mido.MetaMessage("time_signature", numerator=signature[0], denominator=signature[1])))
            previous_signature = signature
        previous_bar = bar
    previous_tick = 0
    for tick, _, message in sorted(meta, key=lambda item: item[:2]):
        message.time = tick - previous_tick
        tempo.append(message)
        previous_tick = tick
    tempo.append(mido.MetaMessage("end_of_track", time=max(0, end_tick - previous_tick)))
    midi.tracks.append(tempo)
    fractional = any(
        note["midi"] != int(note["midi"])
        for track in song["tracks"] if track["instrument"] != "drums" and exportable_track(track)
        for note in _track_events(song, track)
    )
    available = [channel for channel in range(3, 16) if channel != 9]
    has_bend_curves = any(
        note.get("pitchBends")
        for track in song["tracks"] if track["instrument"] != "drums" and exportable_track(track)
        for note in _track_events(song, track)
    )
    if has_bend_curves:
        _export_pitch_bent_midi(midi, song, available)
        midi.save(path)
        return
    for track in song["tracks"]:
        if not exportable_track(track):
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
        elif _resolved_gm_program(track) is not None:
            if not available:
                raise ValueError("MIDI export requires more than 12 independent instrument channels.")
            channel = available.pop(0)
        else:
            channel = 0
        program = _resolved_gm_program(track)
        if program is None:
            program = 53 if channel == 2 else 0
        if channel != 9 and not fractional:
            output.append(mido.Message("program_change", channel=channel, program=program))
        messages = []
        active = {}
        owned = []
        for event in sorted(events, key=lambda item: item["startBeat"]):
            start = max(0, round(event["startBeat"] * midi.ticks_per_beat))
            end = max(start + 1, round((event["startBeat"] + event.get("beats", 0.1)) * midi.ticks_per_beat))
            pitch = gm_pitch(event) if channel == 9 else event["midi"]
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
        output.append(mido.MetaMessage("end_of_track", time=max(0, end_tick - previous)))
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
    bar_map = song_bar_map(song)
    tempo_map = song.get("tempoMap")
    bar_tempos = [round(60 * bar["beats"] / (time_at_beat(tempo_map, song["bpm"], bar["startBeat"] + bar["beats"])
                                              - time_at_beat(tempo_map, song["bpm"], bar["startBeat"])), 3)
                  if tempo_map else song["bpm"] for bar in bar_map]
    small_bars = [bar for bar in bar_map if bar["beats"] < 1 / division]
    gaps = [bar["beats"] for bar in small_bars]
    for track in song["tracks"]:
        if not exportable_track(track):
            continue
        for event in _track_events(song, track):
            onset = event["startBeat"]
            end = onset + event.get("beats", 0.1)
            for bar in small_bars:
                first, last = bar["startBeat"], bar["startBeat"] + bar["beats"]
                if onset < last and end > first:
                    points = sorted({first, last, max(first, onset), min(last, end)})
                    gaps.extend(right - left for left, right in zip(points, points[1:]))
    if gaps:
        while min(gaps) * division < 2:
            division *= 2
    for track in song["tracks"]:
        if not exportable_track(track):
            continue
        part_id = track["id"]
        score_part = ET.SubElement(part_list, "score-part", id=part_id)
        ET.SubElement(score_part, "part-name").text = track["name"]
        program = _resolved_gm_program(track)
        if track["instrument"] == "other" and program is not None:
            instrument_id = f"{part_id}-I1"
            ET.SubElement(ET.SubElement(score_part, "score-instrument", id=instrument_id),
                          "instrument-name").text = track["name"]
            midi_instrument = ET.SubElement(score_part, "midi-instrument", id=instrument_id)
            ET.SubElement(midi_instrument, "midi-channel").text = "1"
            ET.SubElement(midi_instrument, "midi-program").text = str(program + 1)
        part = ET.SubElement(root, "part", id=part_id)
        drum = track["instrument"] == "drums"
        drum_bars = {}
        if drum:
            hits = _track_events(song, track)
            for hit, beat in zip(hits, drum_notation_beats(hits, bar_map)):
                drum_bars.setdefault(bar_index(bar_map, beat), []).append(
                    (max(0, round(beat * division)), drum_key(hit)))
        events = [(max(0, round(event["startBeat"] * division)),
                   max(1, round((event["startBeat"] + event.get("beats", 0.1)) * division)
                       - max(0, round(event["startBeat"] * division))), event)
                  for event in _track_events(song, track)]
        for bar, span in enumerate(bar_map):
            start_tick = round(span["startBeat"] * division)
            end_tick = round((span["startBeat"] + span["beats"]) * division)
            bar_ticks = end_tick - start_tick
            measure = ET.SubElement(part, "measure", number=str(bar + 1),
                                    **({"implicit": "yes"} if span.get("partial") else {}))
            changed = bar == 0 or any(
                span[key] != bar_map[bar - 1][key] for key in ("numerator", "denominator"))
            if changed:
                attrs = ET.SubElement(measure, "attributes")
            if bar == 0:
                ET.SubElement(attrs, "divisions").text = str(division)
            if changed:
                time = ET.SubElement(attrs, "time")
                ET.SubElement(time, "beats").text = str(span["numerator"])
                ET.SubElement(time, "beat-type").text = str(span["denominator"])
            if bar == 0:
                clef = ET.SubElement(attrs, "clef")
                ET.SubElement(clef, "sign").text = "percussion" if drum else "G"
                if not drum:
                    ET.SubElement(clef, "line").text = "2"
                direction = ET.SubElement(measure, "direction")
                ET.SubElement(ET.SubElement(direction, "direction-type"), "words").text = "Draft transcription"
                ET.SubElement(direction, "sound", tempo=str(bar_tempos[0]))
                written_tempo = bar_tempos[0]
            elif not math.isclose(bar_tempos[bar], written_tempo, rel_tol=0.05):
                # Quarter-note tempo changes where the beat unit or speed changes (e.g. 4/4 to 12/8).
                ET.SubElement(measure, "sound", tempo=str(bar_tempos[bar]))
                written_tempo = bar_tempos[bar]
            if drum:
                _drum_measure(measure, drum_bars.get(bar, []), start_tick, end_tick, division)
                continue
            cursor = 0
            for onset, length, event in sorted(events, key=lambda item: item[0]):
                start = max(onset, start_tick)
                end = min(onset + length, end_tick)
                if end <= start:
                    continue
                position = start - start_tick
                if position != cursor:
                    move = ET.SubElement(measure, "forward" if position > cursor else "backup")
                    ET.SubElement(move, "duration").text = str(abs(position - cursor))
                if onset == start and event.get("pitchBends"):
                    description = "; ".join(
                        f"{point['semitones']:+.3f} semitones at +{point['beat']:.3f} beat"
                        for point in event["pitchBends"]
                    )
                    direction = ET.SubElement(measure, "direction", placement="above")
                    ET.SubElement(ET.SubElement(direction, "direction-type"), "words").text = (
                        f"MIDI pitch bend from the written starting pitch: {description}"
                    )
                note = ET.SubElement(measure, "note")
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

DRUM_DISPLAY = {"crash": ("A", 5, "x"), "ride": ("F", 5, "x"), "hihat": ("G", 5, "x"),
                "openhat": ("G", 5, "circle-x"), "hightom": ("E", 5, None), "snare": ("C", 5, None),
                "floortom": ("A", 4, None), "kick": ("F", 4, None),
                # GM detail: the pedalled hat is written with the feet; the six toms get their own positions.
                "pedal": ("D", 4, "x"), "tom50": ("E", 5, None), "tom48": ("D", 5, None), "tom47": ("B", 4, None),
                "tom45": ("A", 4, None), "tom43": ("G", 4, None), "tom41": ("E", 4, None)}
NOTE_TYPES = ((4, "whole", False), (3, "half", True), (2, "half", False), (1.5, "quarter", True),
              (1, "quarter", False), (0.75, "eighth", True), (0.5, "eighth", False), (0.375, "16th", True),
              (0.25, "16th", False), (0.1875, "32nd", True), (0.125, "32nd", False), (0.0625, "64th", False))
FINE_UNITS = (1 / 16, 1 / 12)


def drum_key(hit: dict) -> str:
    """The notation position for a hit: its lane, or a GM tom or pedalled-hat position it names (as the UI score)."""
    source = hit.get("sourceMidi")
    if hit["lane"] == "hihat" and source == 44:
        return "pedal"
    if hit["lane"] == "hightom" and source in (50, 48, 47) or hit["lane"] == "floortom" and source in (45, 43, 41):
        return f"tom{source}"
    return hit["lane"]


def _fine_unit(gap: float) -> float | None:
    """The 64th or 16th-triplet grid that a recurring fine figure fits, if any."""
    best = None
    for unit in FINE_UNITS:
        steps = math.floor(gap / unit + 0.5)
        error = abs(gap / unit - steps)
        if steps >= 1 and error <= 0.15 and (best is None or error < best[1] - 1e-9):
            best = (unit, error)
    return best[0] if best else None


def drum_notation_beats(hits: list[dict], bar_map: list[dict]) -> list[float]:
    """Written beats matching the workspace drum score; source ``startBeat`` stays the playback time.

    Automatic hits (those with a ``confidence``) move to their bar's sixteenth grid (halves round
    up, like the workspace), which removes timing jitter. A same-lane fine figure is kept instead:
    three or more hits with consistent spacing of 0.05-0.2 beat or off the sixteenth grid
    (64th rolls, triplets), or an isolated pair 0.1-0.2 beat apart, whose spacing fits the 64th or
    16th-triplet grid; its hits snap to that grid. Spacing that fits neither is treated as jitter,
    and closer isolated hits are one written hit. Imported hits keep their written rhythm.
    """
    def bar_snap(beat, unit):
        bar = bar_map[bar_index(bar_map, beat)]
        snapped = bar["startBeat"] + math.floor((beat - bar["startBeat"]) / unit + 0.5) * unit
        return snapped if bar["startBeat"] <= snapped < bar["startBeat"] + bar["beats"] - 1e-9 else beat

    automatic = [isinstance(hit.get("confidence"), (int, float)) for hit in hits]
    written = [bar_snap(hit["startBeat"], 0.25) if automatic[index] else hit["startBeat"]
               for index, hit in enumerate(hits)]
    lanes = {}
    for index, hit in enumerate(hits):
        if automatic[index]:
            lanes.setdefault((hit.get("trackId"), hit["lane"]), []).append(index)
    for indexes in lanes.values():
        indexes.sort(key=lambda index: hits[index]["startBeat"])
        beats = [hits[index]["startBeat"] for index in indexes]
        start = 0
        while start < len(indexes) - 1:
            first_gap = beats[start + 1] - beats[start]
            stop = start + 1
            while stop + 1 < len(indexes) and abs(beats[stop + 1] - beats[stop] - first_gap) <= max(0.2 * first_gap, 0.03):
                stop += 1
            gap = (beats[stop] - beats[start]) / (stop - start)
            count = stop - start + 1
            off_grid = abs(gap - math.floor(gap * 4 + 0.5) / 4) > 0.05
            unit = _fine_unit(gap) if gap >= 0.05 else None
            if unit and (count >= 3 and (gap < 0.2 or off_grid) or count == 2 and 0.1 <= gap < 0.2):
                positions = [bar_snap(beat, unit) for beat in beats[start:stop + 1]]
                if any(right <= left for left, right in zip(positions, positions[1:])):
                    positions = beats[start:stop + 1]
                for step, value in zip(range(start, stop + 1), positions):
                    written[indexes[step]] = value
                start = stop + 1
            else:
                start = max(stop if count >= 3 else start + 1, start + 1)
    groups = {}
    for index, hit in enumerate(hits):
        groups.setdefault((hit.get("trackId"), hit["lane"], written[index]), []).append(index)
    for indexes in groups.values():
        sources = [hits[index]["startBeat"] for index in indexes]
        if max(sources) - min(sources) >= 0.1:
            for index in indexes:
                written[index] = hits[index]["startBeat"]
    return written


def _standard(division: int) -> list[tuple[int, str, bool]]:
    return [(round(beats * division), name, dot) for beats, name, dot in NOTE_TYPES
            if beats * division == round(beats * division)]


def _span_pieces(start: int, end: int, division: int) -> list[tuple[int, str | None, bool, bool]]:
    """Standard values for a span, split at beats when needed; 3:2 triplets where exact."""
    standard = _standard(division)
    pieces, left = [], end - start
    while left > 0:
        match = next((value for value in standard if value[0] <= left), None)
        if match is None:
            break
        pieces.append((*match, False))
        left -= match[0]
    if not left:
        return pieces
    boundary = (start // division + 1) * division
    if start < boundary < end:
        return _span_pieces(start, boundary, division) + _span_pieces(boundary, end, division)
    triplet = next((value for value in standard if value[0] * 2 == (end - start) * 3), None)
    return [(end - start, triplet[1], triplet[2], True)] if triplet else pieces + [(left, None, False, False)]


def _note_value(note, piece) -> None:
    _, name, dot, triplet = piece
    if name:
        ET.SubElement(note, "type").text = name
        if dot:
            ET.SubElement(note, "dot")
        if triplet:
            modification = ET.SubElement(note, "time-modification")
            ET.SubElement(modification, "actual-notes").text = "3"
            ET.SubElement(modification, "normal-notes").text = "2"


def _drum_measure(measure, hits: list[tuple[int, str]], start_tick: int, end_tick: int, division: int) -> None:
    """Hands up (voice 1) and kick down (voice 2); each written length reaches the next attack."""
    bar_ticks = end_tick - start_tick
    for number, feet in ((1, False), (2, True)):
        if number == 2:
            ET.SubElement(ET.SubElement(measure, "backup"), "duration").text = str(bar_ticks)
        attacks = {}
        for tick, lane in hits:
            if (lane in ("kick", "pedal")) == feet and start_tick <= tick < end_tick:
                lanes = attacks.setdefault(tick - start_tick, [])
                if lane not in lanes:
                    lanes.append(lane)
        positions = sorted(attacks)
        cursor = 0

        def rest(first, last):
            pieces = ([(bar_ticks, None, False, False)] if last - first == bar_ticks
                      else _span_pieces(first, last, division))
            for piece in pieces:
                note = ET.SubElement(measure, "note")
                ET.SubElement(note, "rest", **({"measure": "yes"} if last - first == bar_ticks else {}))
                ET.SubElement(note, "duration").text = str(piece[0])
                ET.SubElement(note, "voice").text = str(number)
                _note_value(note, piece)

        for index, position in enumerate(positions):
            if position > cursor:
                rest(cursor, position)
            following = positions[index + 1] if index + 1 < len(positions) else bar_ticks
            head = _span_pieces(position, following, division)[0]
            for chord, lane in enumerate(attacks[position]):
                step, octave, notehead = DRUM_DISPLAY.get(lane, ("C", 5, None))
                note = ET.SubElement(measure, "note")
                if chord:
                    ET.SubElement(note, "chord")
                unpitched = ET.SubElement(note, "unpitched")
                ET.SubElement(unpitched, "display-step").text = step
                ET.SubElement(unpitched, "display-octave").text = str(octave)
                ET.SubElement(note, "duration").text = str(head[0])
                ET.SubElement(note, "voice").text = str(number)
                _note_value(note, head)
                ET.SubElement(note, "stem").text = "down" if feet else "up"
                if notehead:
                    ET.SubElement(note, "notehead").text = notehead
            cursor = position + head[0]
        if cursor < bar_ticks:
            rest(cursor, bar_ticks)