import errno
import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Event
from unittest.mock import Mock
from uuid import uuid4

import numpy as np
import pytest
from scipy.io import wavfile

from mizan.api import Api, queue_job
from mizan.engine import media, pipeline
from mizan.engine.audio import Audio, read_audio
from mizan.engine.models import HTDEMUCS_6S
from mizan.engine.separation import SOURCES
from mizan.errors import Cancelled, DownloadFailed, InsufficientDisk, ModelFailed
from mizan.jobs import JobRunner, JobStore, STAGES
from mizan.library import LibraryStore
from mizan.paths import app_dir
from test_engine_pipeline import fake_ingestion, fake_models, fixture_audio
from test_jobs import URL, wait_for


@pytest.fixture(autouse=True)
def use_fake_models(monkeypatch):
    fake_models(monkeypatch)


@pytest.fixture
def saved_recording(monkeypatch):
    directory = app_dir("cache") / str(uuid4())
    directory.mkdir()
    original = directory / "original.wav"
    # Include leading silence and a non-rounded duration to detect time-base changes.
    samples = np.concatenate((np.zeros((137, 2)), fixture_audio().samples))
    wavfile.write(original, 22050, (samples * 16000).astype(np.int16))
    analysis = directory / "analysis.json"
    analysis.write_text(json.dumps({
        "title": "Saved recording", "source": URL, "durationSeconds": len(samples) / 22050,
        "tracks": [], "piano": [], "drums": [], "chords": [],
    }), encoding="utf-8")
    entry = LibraryStore().upsert_job({
        "url": URL, "details": {
            "metadata": {"duration": 8, "channel": "Saved artist"},
            "artifacts": {"mix": str(original), "original": str(original), "analysis": str(analysis)},
        },
    }, "v3")
    return entry, original


def forbid_ingestion(monkeypatch):
    calls = {}
    for name in ("inspect_video", "download_video", "decode", "ffmpeg_path"):
        calls[name] = Mock(side_effect=AssertionError(f"{name} must not run"))
        monkeypatch.setattr(pipeline, name, calls[name])
    return calls


def reprocess_job(entry):
    return {
        "id": str(uuid4()), "song_id": entry["id"], "kind": "transcribe",
        "url": URL, "video_id": "aB_12-cD345", "instrument": "auto",
        "details": {"metadata": {"title": "Untrusted", "duration": 999}},
    }


def test_reprocess_api_reuses_exact_audio_and_deduplicates(saved_recording, monkeypatch):
    entry, original = saved_recording
    old_files = {path: path.read_bytes() for path in original.parent.iterdir()}
    forbidden = forbid_ingestion(monkeypatch)
    entered, release = Event(), Event()
    snapshots = []

    def processing(job, report, cancelled):
        entered.set()
        assert release.wait(5)

        def progress(stage, value, **kwargs):
            report(stage, value, **kwargs)
            snapshots.append(queue_job(runner.store.get(job["id"])))

        return pipeline.run_pipeline(job, progress, cancelled)

    runner = JobRunner(JobStore(), processing)
    try:
        api = Api(runner)
        with ThreadPoolExecutor(max_workers=4) as pool:
            replies = list(pool.map(api.reprocess_song, [entry["id"]] * 4))
        assert entered.wait(5)
        assert all(reply["ok"] for reply in replies)
        assert len({reply["job"]["id"] for reply in replies}) == 1
        assert runner.library.get(entry["id"]) == entry
        release.set()
        done = wait_for(runner.store, replies[0]["job"]["id"], "done")
        updated = runner.library.get(entry["id"])
        assert done["song_id"] == entry["id"]
        assert updated["artist"] == "Saved artist"
        assert len(runner.library.list()) == 1
        fresh = Path(done["details"]["artifacts"]["original"])
        assert fresh != original and fresh.read_bytes() == old_files[original]
        assert fresh == Path(done["details"]["artifacts"]["mix"])
        song = json.loads(Path(done["details"]["artifacts"]["analysis"]).read_text())
        assert song["durationSeconds"] == read_audio(original).duration == updated["duration"]
        assert song["title"] == entry["title"]
        assert song["source"] == URL
        for stage, method in (("inspect", "saved-audio-validation"),
                              ("download", "reused-saved-audio"), ("decode", "reused-decoded-wav")):
            detail = done["details"]["diagnostics"][stage]
            assert detail["method"] == method and detail["seconds"] >= 0
            assert any(snapshot["stage"] == stage and
                       next(s for s in snapshot["stages"] if s["name"] == stage)["method"] == method
                       for snapshot in snapshots)
        assert all(a["progress"] <= b["progress"] for a, b in zip(snapshots, snapshots[1:]))
        assert {path: path.read_bytes() for path in original.parent.iterdir()} == old_files
        # New artifacts do not alias the prior cache, even during result cleanup.
        pipeline.discard_result(done["id"])
        assert original.read_bytes() == old_files[original]
        for call in forbidden.values():
            call.assert_not_called()
    finally:
        release.set()
        runner.close()


@pytest.mark.parametrize("damage", [None, "missing", "wrong_length", "wrong_model"])
def test_reprocess_reuses_only_matching_six_stems(saved_recording, monkeypatch, damage):
    entry, original = saved_recording
    audio = read_audio(original)
    artifacts = dict(entry["artifacts"])
    for name in SOURCES:
        stem = original.with_name(f"{name}.wav")
        wavfile.write(stem, audio.rate, audio.samples)
        artifacts[name] = str(stem)
    analysis = original.with_name("analysis.json")
    prior = json.loads(analysis.read_text(encoding="utf-8"))
    prior.update(diagnostics={"separate": {"method": "htdemucs-6s-onnx"}},
                 modelVersions={"separation": HTDEMUCS_6S["version"]})
    if damage == "missing":
        original.with_name("bass.wav").unlink()
    elif damage == "wrong_length":
        wavfile.write(original.with_name("bass.wav"), audio.rate, audio.samples[:-1])
    elif damage == "wrong_model":
        prior["modelVersions"]["separation"] = "outdated"
    analysis.write_text(json.dumps(prior), encoding="utf-8")
    LibraryStore().upsert_job({
        "song_id": entry["id"], "url": URL,
        "details": {"artifacts": artifacts},
    }, "v4")
    forbid_ingestion(monkeypatch)
    separator = Mock(side_effect=lambda mix, cancelled, progress, active: (
        {name: Audio(np.zeros_like(mix.samples), mix.rate) for name in SOURCES},
        {"method": "htdemucs-6s-onnx", "provider": {"effectiveProviders": ["CPU"]}, "warnings": []}))
    monkeypatch.setattr(pipeline, "_demucs", separator)
    result = pipeline.run_pipeline(reprocess_job(entry), lambda *args, **kwargs: None, Event())
    diagnostics = result["diagnostics"]["separate"]
    if damage is None:
        separator.assert_not_called()
        assert diagnostics["reused"] is True
        assert diagnostics["provider"]["effectiveProviders"] == ["Saved audio"]
        assert all(Path(result["artifacts"][name]).read_bytes() == Path(artifacts[name]).read_bytes()
                   for name in SOURCES if name in result["artifacts"])
    else:
        separator.assert_called_once()
        assert not diagnostics.get("reused")
        if damage != "wrong_model":
            assert any("Saved stems could not be reused" in warning for warning in result["warnings"])


def test_reprocess_snapshots_selected_model_and_keeps_saved_metadata_until_success(saved_recording):
    entry, _ = saved_recording
    store = JobStore()
    store.set_transcription_model("muscriptor-medium")
    started, release = Event(), Event()

    def processing(job, report, cancelled):
        started.set()
        assert release.wait(5)
        return {"artifacts": entry["artifacts"], "metadata": {"title": entry["title"]}}

    runner = JobRunner(store, processing)
    try:
        job = runner.reprocess(entry["id"])
        assert started.wait(5)
        assert job["transcription_model"] == "muscriptor-medium"
        assert runner.library.get(entry["id"]) == entry
        store.set_transcription_model("muscriptor-small")
        release.set()
        wait_for(store, job["id"], "done")
        assert runner.library.get(entry["id"])["transcription_model"] == "muscriptor-medium"
        assert Api(runner).list_library()["entries"][0]["transcriptionModel"] == "muscriptor-medium"
    finally:
        release.set()
        runner.close()


@pytest.mark.parametrize("cancel_stage", STAGES)
def test_cached_cancel_never_deletes_prior_cache(saved_recording, monkeypatch, cancel_stage):
    entry, original = saved_recording
    before = original.read_bytes()
    forbid_ingestion(monkeypatch)
    job, event = reprocess_job(entry), Event()

    def report(stage, progress, **kwargs):
        if stage == cancel_stage and progress == 1:
            event.set()
            raise Cancelled()

    with pytest.raises(Cancelled):
        pipeline.run_pipeline(job, report, event)
    assert original.read_bytes() == before
    assert LibraryStore().get(entry["id"]) == entry
    assert not (app_dir("tmp") / job["id"]).exists()
    assert not (app_dir("cache") / job["id"]).exists()


@pytest.mark.parametrize("late_cancel", [False, True])
def test_cached_failure_and_post_publish_cancel_preserve_source(saved_recording, monkeypatch, late_cancel):
    entry, original = saved_recording
    before = original.read_bytes()
    forbid_ingestion(monkeypatch)
    if not late_cancel:
        monkeypatch.setattr(pipeline, "analyze_decoded", Mock(side_effect=ModelFailed("test failure")))

    def processing(job, report, cancelled):
        result = pipeline.run_pipeline(job, report, cancelled)
        cancelled.set()
        return result

    runner = JobRunner(JobStore(), processing)
    try:
        job = runner.reprocess(entry["id"])
        wait_for(runner.store, job["id"], "cancelled" if late_cancel else "failed")
        assert original.read_bytes() == before
        assert runner.library.get(entry["id"]) == entry
        assert not (app_dir("tmp") / job["id"]).exists()
        assert not (app_dir("cache") / job["id"]).exists()
    finally:
        runner.close()


@pytest.mark.parametrize("damage", ["missing", "corrupt", "truncated", "unreadable"])
def test_bad_cached_audio_falls_back_explicitly(saved_recording, monkeypatch, damage):
    entry, original = saved_recording
    fake_ingestion(monkeypatch)
    if damage == "missing":
        original.unlink()
    elif damage == "corrupt":
        original.write_bytes(b"not audio")
    elif damage == "truncated":
        original.write_bytes(original.read_bytes()[:-200])
    else:
        open_path = Path.open

        def unreadable(path, *args, **kwargs):
            if path == original:
                raise PermissionError("test unreadable source")
            return open_path(path, *args, **kwargs)

        monkeypatch.setattr(Path, "open", unreadable)
    spies = {}
    for name in ("inspect_video", "download_video", "decode"):
        spies[name] = Mock(wraps=getattr(pipeline, name))
        monkeypatch.setattr(pipeline, name, spies[name])
    job = reprocess_job(entry)
    result = pipeline.run_pipeline(job, lambda *args, **kwargs: None, Event())
    for spy in spies.values():
        spy.assert_called_once()
    assert any("downloading from YouTube again" in warning for warning in result["warnings"])
    assert result["metadata"]["title"] == "Synthetic study"
    assert result["diagnostics"]["download"]["method"] == "yt-dlp"
    assert original.exists() == (damage != "missing")


def test_missing_cached_audio_offline_fails_with_warning(saved_recording, monkeypatch):
    entry, original = saved_recording
    original.unlink()
    fake_ingestion(monkeypatch)
    monkeypatch.setattr(pipeline, "inspect_video", Mock(side_effect=DownloadFailed("offline")))
    runner = JobRunner(JobStore())
    try:
        job = runner.reprocess(entry["id"])
        failed = wait_for(runner.store, job["id"], "failed")
        assert failed["error_code"] == "download_failed"
        assert "offline" in failed["error_message"]
        assert any("downloading from YouTube again" in warning for warning in failed["details"]["warnings"])
        assert runner.library.get(entry["id"]) == entry
        assert not (app_dir("tmp") / job["id"]).exists()
    finally:
        runner.close()


def test_valid_original_used_when_mix_is_bad(saved_recording, monkeypatch):
    entry, original = saved_recording
    forbid_ingestion(monkeypatch)
    broken = original.with_name("bad-mix.wav")
    broken.write_bytes(b"not a wav")
    LibraryStore().upsert_job({
        "song_id": entry["id"], "url": URL,
        "details": {"artifacts": {**entry["artifacts"], "mix": str(broken)}},
    }, "v4")
    result = pipeline.run_pipeline(reprocess_job(entry), lambda *args, **kwargs: None, Event())
    assert Path(result["artifacts"]["original"]).read_bytes() == original.read_bytes()
    assert broken.read_bytes() == b"not a wav"


@pytest.mark.parametrize("mismatch", ["url", "video_id", "import", "external_path"])
def test_cache_trust_boundary(saved_recording, monkeypatch, tmp_path, mismatch):
    entry, original = saved_recording
    before = original.read_bytes()
    fake_ingestion(monkeypatch)
    job = reprocess_job(entry)
    if mismatch == "url":
        job["url"] = "https://youtu.be/bB_12-cD345"
    elif mismatch == "video_id":
        job["video_id"] = "bB_12-cD345"
    elif mismatch == "import":
        imported = LibraryStore().create_import("Linked MIDI", "midi", {"tracks": []},
                                               entry["artifacts"], "import")
        job["song_id"] = imported["id"]
    else:
        outside = tmp_path / "outside.wav"
        outside.write_bytes(before)
        LibraryStore().upsert_job({
            "song_id": entry["id"], "url": URL, "details": {
                "artifacts": {**entry["artifacts"], "mix": str(outside), "original": str(outside)},
            },
        }, "v3")
    copied = Mock(wraps=pipeline.copy_decoded)
    monkeypatch.setattr(pipeline, "copy_decoded", copied)
    result = pipeline.run_pipeline(job, lambda *args, **kwargs: None, Event())
    copied.assert_not_called()
    assert any("downloading from YouTube again" in warning for warning in result["warnings"])
    assert original.read_bytes() == before


def test_job_details_cannot_supply_audio_paths(saved_recording, monkeypatch):
    entry, original = saved_recording
    fake_ingestion(monkeypatch)
    job = reprocess_job(entry)
    job.pop("song_id")
    job["details"] = {"sourcePath": str(original), "artifacts": entry["artifacts"]}
    download = Mock(wraps=pipeline.download_video)
    monkeypatch.setattr(pipeline, "download_video", download)
    pipeline.run_pipeline(job, lambda *args, **kwargs: None, Event())
    download.assert_called_once()


def test_copy_is_cancellable_without_modifying_source(saved_recording, monkeypatch, tmp_path):
    _, original = saved_recording
    before = original.read_bytes()
    event = Event()
    check_cancel = media.check_cancel
    checks = 0

    def cancel_during_copy(cancelled):
        nonlocal checks
        checks += 1
        if checks == 3:
            event.set()
        check_cancel(cancelled)

    monkeypatch.setattr(media, "check_cancel", cancel_during_copy)
    with pytest.raises(Cancelled):
        media.copy_decoded(original, tmp_path / "copy.wav", event)
    assert original.read_bytes() == before


@pytest.mark.parametrize("dtype,rate", [(np.int16, 22050), (np.float32, 44100)])
def test_copy_preserves_pcm_and_float_sample_timebase(tmp_path, dtype, rate):
    original, copied = tmp_path / "original.wav", tmp_path / "copied.wav"
    samples = np.zeros((rate + 137, 2), dtype=dtype)
    samples[137:200] = 1
    wavfile.write(original, rate, samples)
    duration = media.copy_decoded(original, copied, Event())
    assert copied.read_bytes() == original.read_bytes()
    assert read_audio(copied).rate == rate
    assert duration == len(samples) / rate


def test_copy_disk_failure_does_not_redownload_or_delete_source(saved_recording, monkeypatch):
    entry, original = saved_recording
    before = original.read_bytes()
    forbid_ingestion(monkeypatch)
    monkeypatch.setattr(pipeline, "copy_decoded", Mock(side_effect=OSError(errno.ENOSPC, "disk full")))
    job = reprocess_job(entry)
    with pytest.raises(InsufficientDisk):
        pipeline.run_pipeline(job, lambda *args, **kwargs: None, Event())
    assert original.read_bytes() == before
    assert not (app_dir("tmp") / job["id"]).exists()


def test_reprocess_does_not_replace_linked_import(saved_recording):
    entry, _ = saved_recording
    library = LibraryStore()
    imported = library.create_import("MIDI with recording", "midi", {"tracks": []},
                                     entry["artifacts"], "import")
    song = json.loads(Path(imported["song_path"]).read_text())
    linked = library.update_recording(imported["id"], entry["artifacts"], song, [])
    runner = JobRunner(JobStore())
    try:
        response = Api(runner).reprocess_song(imported["id"])
        assert not response["ok"] and "Only YouTube" in response["error"]["message"]
        assert runner.store.list() == []
        assert library.get(imported["id"]) == linked
    finally:
        runner.close()
