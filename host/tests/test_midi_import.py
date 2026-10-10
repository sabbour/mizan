import base64
import io
from pathlib import Path

import mido
import pytest

from mizan.api import Api
from mizan.engine.output import export_midi, tempo_changes
from mizan.errors import InvalidFile
from mizan.imports import notes_to_song, parse_midi
from mizan.jobs import JobRunner, JobStore
from mizan.library import LibraryStore
from mizan.meter import time_at_beat


def midi_bytes(messages, *, format=1):
    midi = mido.MidiFile(type=format, ticks_per_beat=480)
    midi.tracks.append(mido.MidiTrack(messages))
    output = io.BytesIO()
    midi.save(file=output)
    return output.getvalue()


def song_from_midi(data):
    _, bpm, bpb, unit, parts = parse_midi(data)
    return notes_to_song("Synthetic MIDI", "midi", bpm, bpb, unit, parts)


@pytest.mark.parametrize("format", [0, 1])
def test_mixed_channels_keep_percussion_and_instrument_programs(format, tmp_path):
    data = midi_bytes([
        mido.MetaMessage("track_name", name="Mixed"),
        mido.Message("program_change", channel=0, program=0),
        mido.Message("program_change", channel=1, program=21),
        mido.Message("program_change", channel=2, program=24),
        mido.Message("note_on", channel=0, note=60, velocity=100),
        mido.Message("note_on", channel=1, note=64, velocity=80),
        mido.Message("note_on", channel=2, note=67, velocity=90),
        mido.Message("note_on", channel=9, note=53, velocity=110),
        mido.Message("note_off", channel=9, note=53, time=120),
        mido.Message("note_off", channel=0, note=60, time=360),
        mido.Message("note_off", channel=1, note=64),
        mido.Message("note_off", channel=2, note=67),
    ], format=format)
    song = song_from_midi(data)
    assert len(song["piano"]) == 1
    assert song["piano"][0]["midi"] == 60
    assert len(song["drums"]) == 1
    assert song["drums"][0]["sourceMidi"] == 53
    assert song["drums"][0]["velocity"] == pytest.approx(110 / 127, abs=0.0001)
    programs = {track["gmProgram"]: track for track in song["tracks"] if "gmProgram" in track}
    assert set(programs) == {21, 24}
    assert [song["instrumentNotes"][programs[p]["id"]][0]["midi"] for p in (21, 24)] == [64, 67]
    assert len({track["id"] for track in song["tracks"]}) == 4
    exported = tmp_path / "mixed.mid"
    export_midi(song, exported)
    reopened = song_from_midi(exported.read_bytes())
    assert len(reopened["piano"]) == 1 and len(reopened["drums"]) == 1
    assert reopened["drums"][0]["sourceMidi"] == 53
    assert {track.get("gmProgram") for track in reopened["tracks"]} == {None, 21, 24}


@pytest.mark.parametrize("program", range(16, 24))
def test_organ_and_accordion_programs_are_not_piano(program):
    song = song_from_midi(midi_bytes([
        mido.Message("program_change", channel=0, program=program),
        mido.Message("note_on", channel=0, note=60, velocity=90),
        mido.Message("note_off", channel=0, note=60, time=480),
    ]))
    assert not song["piano"]
    assert song["tracks"][0]["instrument"] == "other"
    assert song["tracks"][0]["gmProgram"] == program
    assert len(song["instrumentNotes"][song["tracks"][0]["id"]]) == 1


def changing_tempo_midi():
    return midi_bytes([
        mido.MetaMessage("set_tempo", tempo=500000),
        mido.Message("note_on", note=60, velocity=90),
        mido.MetaMessage("set_tempo", tempo=1000000, time=960),
        mido.MetaMessage("set_tempo", tempo=333333, time=960),
        mido.Message("note_off", note=60, time=960),
    ])


def test_tempo_changes_keep_exact_seconds_and_export(tmp_path):
    song = song_from_midi(changing_tempo_midi())
    assert song["bpm"] == 120
    assert time_at_beat(song.get("tempoMap"), song["bpm"], 1) == pytest.approx(0.5)
    assert time_at_beat(song.get("tempoMap"), song["bpm"], 3) == pytest.approx(2)
    assert time_at_beat(song.get("tempoMap"), song["bpm"], 5) == pytest.approx(3.333333)
    assert time_at_beat(song.get("tempoMap"), song["bpm"], 7) == pytest.approx(3.999999)
    assert [beat for beat, _ in tempo_changes(song)] == [0, 2, 4]
    for chord in song["chords"]:
        assert chord["onset"] == pytest.approx(time_at_beat(song["tempoMap"], 120, chord["startBeat"]))
        assert chord["offset"] == pytest.approx(time_at_beat(song["tempoMap"], 120, chord["startBeat"] + chord["beats"]))
    exported = tmp_path / "tempo.mid"
    export_midi(song, exported)
    reopened = song_from_midi(exported.read_bytes())
    for beat in (0, 1, 2, 3, 4, 5, 6):
        assert time_at_beat(reopened["tempoMap"], reopened["bpm"], beat) == pytest.approx(
            time_at_beat(song["tempoMap"], song["bpm"], beat), abs=0.000001)


def test_late_and_same_tick_tempo_changes_keep_default_intro():
    song = song_from_midi(midi_bytes([
        mido.Message("note_on", note=60, velocity=90),
        mido.MetaMessage("set_tempo", tempo=750000, time=960),
        mido.MetaMessage("set_tempo", tempo=1000000),
        mido.Message("note_off", note=60, time=480),
    ]))
    assert song["bpm"] == 120
    assert song["tempoMap"] == [
        {"beat": 0, "time": 0}, {"beat": 2, "time": 1}, {"beat": 3, "time": 2},
    ]


def test_tempo_at_end_keeps_final_segment_for_extrapolation():
    song = song_from_midi(midi_bytes([
        mido.Message("note_on", note=60, velocity=90),
        mido.Message("note_off", note=60, time=480),
        mido.MetaMessage("set_tempo", tempo=1000000),
    ]))
    assert time_at_beat(song.get("tempoMap"), song["bpm"], 2) == pytest.approx(1.5)


def test_zero_tempo_has_clear_import_error():
    with pytest.raises(InvalidFile, match="tempo"):
        parse_midi(midi_bytes([
            mido.MetaMessage("set_tempo", tempo=0),
            mido.Message("note_on", note=60, velocity=90),
            mido.Message("note_off", note=60, time=480),
        ]))


def test_split_hands_keep_tempo_map_on_save_and_reopen():
    source = mido.MidiFile(file=io.BytesIO(changing_tempo_midi()))
    source.tracks[0].insert(0, mido.MetaMessage("track_name", name="up"))
    source.tracks.append(mido.MidiTrack([
        mido.MetaMessage("track_name", name="down"),
        mido.Message("note_on", note=48, velocity=90),
        mido.Message("note_off", note=48, time=2880),
    ]))
    output = io.BytesIO()
    source.save(file=output)
    data = output.getvalue()
    runner = JobRunner(JobStore(), lambda job, report, cancelled: None)
    api = Api(runner)
    try:
        created = api.import_file("synthetic.mid", base64.b64encode(data).decode())
        assert created["ok"]
        opened = api.open_song(created["entry"]["id"])
        song = opened["song"]
        assert len(song["tracks"]) == 1
        assert {note["hand"] for note in song["piano"]} == {"left", "right"}
        assert time_at_beat(song.get("tempoMap"), song["bpm"], 3) == pytest.approx(2)
        original = LibraryStore().get(created["entry"]["id"])["artifacts"]["midi"]
        assert Path(original).read_bytes() == data
    finally:
        runner.close()
