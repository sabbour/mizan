import json
import time
from pathlib import Path
from threading import Event
from uuid import uuid4

import mido
import numpy as np
import pytest

from mizan.api import Api
from mizan.engine import media, pipeline
from mizan.engine.audio import Audio, read_audio, write_audio
from mizan.engine.harmony import analyze_harmony
from mizan.engine.media import decode, ffmpeg_path, preflight
from mizan.engine.output import build_song, export_midi, quantize
from mizan.errors import Cancelled, DownloadFailed, InsufficientDisk, UnsupportedMedia
from mizan.jobs import JobRunner, JobStore
from mizan.paths import app_dir
from test_drums import drum_sound
from test_harmony import synth_chord
from test_jobs import URL, wait_for


def fixture_audio():
    samples = np.concatenate([synth_chord(notes) for notes in
                              ([60, 64, 67], [57, 60, 64], [53, 57, 60], [55, 59, 62])])
    for index in range(16):
        sound = drum_sound("kick" if index % 2 == 0 else "snare") * 0.5
        start = round(index * 0.5 * 22050)
        samples[start:start + len(sound)] += sound
    return Audio(np.column_stack((samples, samples * 0.8)), 22050)


def fake_ingestion(monkeypatch):
    monkeypatch.setattr(pipeline, "ffmpeg_path", lambda: "test-ffmpeg")
    monkeypatch.setattr(pipeline, "inspect_video", lambda url, work, event:
                        {"title": "Synthetic study", "duration": 8, "videoId": "aB_12-cD345",
                         "source": url, "thumbnail": None})

    def download(url, work, event, progress):
        path = work / "source.wav"
        write_audio(path, fixture_audio())
        progress(1)
        return path

    def decode_local(source, output, event):
        write_audio(output, read_audio(source))

    monkeypatch.setattr(pipeline, "download_video", download)
    monkeypatch.setattr(pipeline, "decode", decode_local)


def fake_models(monkeypatch):
    monkeypatch.setattr("mizan.engine.muscriptor.prepare_model", lambda *args: None)
    monkeypatch.setattr(pipeline, "_parallel_ram_safe", lambda *args: False)

    def demucs(audio, cancelled, progress, active):
        silence = Audio(np.zeros_like(audio.samples), audio.rate)
        progress(1)
        return {
            "piano": audio, "drums": audio, "vocals": silence,
            "guitar": silence, "bass": silence, "other": silence,
        }, {"method": "htdemucs-6s-onnx", "provider": {"effectiveProviders": ["CPU"]},
            "warnings": []}

    def official(model, audio, cancelled, progress, *, source):
        progress(1)
        return (
            [{"midi": 60, "onset": 0.5, "offset": 1.0, "velocity": 0.5,
              "confidence": 0.4, "generated": False, "hand": "right"}],
            [{"lane": "kick", "sourceMidi": 36, "onset": 0.25, "velocity": 0.5,
              "confidence": 0.4, "possibleLanes": ["kick"]}],
            {"method": f"{model}-pytorch-cpu", "model": {"id": model, "version": "test"},
             "provider": {"effectiveProviders": ["PyTorch CPU"]}, "warnings": []},
            [],
        )

    monkeypatch.setattr(pipeline, "_demucs", demucs)
    monkeypatch.setattr("mizan.engine.muscriptor.transcribe_official", official)


def test_only_muscriptor_transcribes_and_persists_result(monkeypatch):
    from mizan import cloud
    fake_ingestion(monkeypatch)
    fake_models(monkeypatch)
    monkeypatch.setattr(cloud, "status",
                        lambda: pytest.fail("Local processing contacted Azure"))
    runner = JobRunner(JobStore())
    try:
        job = runner.start(URL, "piano")
        done = wait_for(runner.store, job["id"], "done")
        result = Api(runner).open_result(job["id"])
        assert result["ok"]
        song = result["song"]
        assert done["transcription_model"] == "muscriptor-small"
        assert song["piano"][0]["hand"] == "right"
        assert done["details"]["transcribedInstruments"] == ["piano"]
        assert song["diagnostics"]["transcribe"]["model"]["id"] == "muscriptor-small"
        assert Path(done["details"]["artifacts"]["midi"]).is_file()
        assert runner.start(URL, "piano")["id"] == job["id"]
    finally:
        runner.close()


def test_decoding_error_summary_survives_saved_result(monkeypatch):
    fake_ingestion(monkeypatch)
    fake_models(monkeypatch)
    decoder_warning = "MuScriptor decoder warning"
    decode_errors = {"count": 2, "details": [
        {"chunk": 3, "seekSeconds": 15.0, "tokenLimit": 2000},
        {"chunk": 4, "seekSeconds": 20.0, "tokenLimit": 2000},
    ]}

    def transcribe(*_args, **_kwargs):
        return (
            [{"midi": 60, "onset": 0.5, "offset": 1.0, "velocity": 0.5,
              "confidence": 0.4, "generated": False, "hand": "right"}],
            [],
            {"method": "muscriptor-small-pytorch-cpu",
             "model": {"id": "muscriptor-small", "version": "test"},
             "provider": {"effectiveProviders": ["PyTorch CPU"]},
             "warnings": [decoder_warning], "decodingErrors": decode_errors},
            [],
        )

    monkeypatch.setattr("mizan.engine.muscriptor.transcribe_official", transcribe)
    runner = JobRunner(JobStore())
    try:
        job = runner.start(URL, "piano")
        done = wait_for(runner.store, job["id"], "done")
        result = Api(runner).open_result(job["id"])
        assert result["ok"]
        song = result["song"]
        assert done["details"]["decodingErrors"]["count"] == 2
        assert song["decodingErrors"]["byInput"] == {"mix": 2}
        assert song["diagnostics"]["transcribe"]["decodingErrors"] == song["decodingErrors"]
        assert decoder_warning in song["diagnostics"]["transcribe"]["warnings"]
        assert any("Best-effort transcription: 2 chunks" in warning
                   for warning in song["warnings"])
    finally:
        runner.close()


def test_muscriptor_only_cloud_job_cannot_publish_a_local_separation_as_gpu(monkeypatch, tmp_path):
    from mizan import cloud
    from mizan.cloud import CloudError
    monkeypatch.setattr(pipeline, "app_dir", lambda name: tmp_path / name)
    (tmp_path / "tmp").mkdir()
    (tmp_path / "cache").mkdir()
    fake_ingestion(monkeypatch)
    monkeypatch.setattr(cloud, "status",
                        lambda: {"available": False, "configured": False})
    job = {"id": str(uuid4()), "url": URL, "instrument": "piano",
           "details": {"processingMode": "cloud"}}
    with pytest.raises(CloudError, match="customer GPU smoke run"):
        pipeline.run_pipeline(job, lambda *args, **kwargs: None, Event())
    assert not (app_dir("cache") / job["id"]).exists()


def test_cached_local_decode_then_tls_get_failure_is_reported_as_cloud_failure(
        monkeypatch, tmp_path):
    from mizan import cloud
    from mizan.api import queue_job
    from mizan.cloud_transport import CloudTransport, CloudTransportError

    cached = tmp_path / "cached-original.wav"
    write_audio(cached, fixture_audio())
    metadata = {"title": "Cached study", "duration": 8, "videoId": "aB_12-cD345",
                "source": URL, "thumbnail": None}

    def reuse_recording(_job, output, cancelled):
        pipeline.copy_decoded(cached, output, cancelled)
        return metadata, [], cached

    monkeypatch.setattr(pipeline, "_reuse_recording", reuse_recording)
    monkeypatch.setattr(cloud, "selected", lambda: True)
    status_calls = []

    reports = []
    def status():
        assert reports[-1] == ("detect", 0, "Connecting to Azure GPU processing")
        assert ("decode", 1, None) in reports
        status_calls.append("status")
        return {"available": True, "configured": True}

    monkeypatch.setattr(cloud, "status", status)

    transport = CloudTransport({
        "tenantId": "11111111-1111-1111-1111-111111111111",
        "subscriptionId": "33333333-3333-3333-3333-333333333333",
        "resourceGroup": "rg-mizan", "storageAccount": "mizanblob",
        "container": "jobs", "jobName": "mizan-gpu-transcribe",
    })
    template_gets = []
    monkeypatch.setattr(transport, "delete", lambda *args: None)

    def upload(_name, _path, **kwargs):
        assert reports[-1] == ("detect", 0, "Uploading prepared audio")

    def fail_open(_url, **kwargs):
        assert reports[-1] == ("detect", 0, "Checking Azure GPU Job")
        template_gets.append(kwargs.get("method", "GET"))
        raise CloudTransportError("Could not reach Azure for GET (tls) after 3 attempts.")

    monkeypatch.setattr(transport, "_put", upload)
    monkeypatch.setattr(transport, "_open", fail_open)

    def fail_template_get(recording, directory, model, cancelled, report):
        assert recording.is_file()
        assert recording.name == "original.wav"
        try:
            return transport.run(recording, directory, model, cancelled, report)
        except CloudTransportError as exc:
            raise cloud.CloudError(str(exc)) from exc

    def capture_pipeline(job, report, cancelled):
        def capture_report(stage, progress, **kwargs):
            reports.append((stage, progress, kwargs.get("message")))
            report(stage, progress, **kwargs)
        return pipeline.run_pipeline(job, capture_report, cancelled)

    runner = JobRunner(JobStore(), pipeline=capture_pipeline)
    try:
        monkeypatch.setattr(cloud, "offload", fail_template_get)
        job = runner.start(URL, "piano")
        failed = wait_for(runner.store, job["id"], "failed")
        summary = queue_job(failed)
        assert failed["error_code"] == "cloud_failed"
        assert failed["stage"] == "detect"
        assert "Could not reach Azure" in failed["error_message"]
        assert summary["progress"] == round(3 / 9, 6)
        assert summary["stageMessage"] == "Checking Azure GPU Job"
        assert status_calls == ["status"]
        assert summary["fix"] == (
            "Check your Azure sign-in and connectivity, then retry Cloud processing.")
        assert template_gets == ["GET"], "template failure must not submit /start"
        assert [message for stage, _, message in reports if stage == "detect"] == [
            "Connecting to Azure GPU processing",
            "Connecting to Azure GPU processing", "Uploading prepared audio",
            "Checking Azure GPU Job"]
        assert [(stage["name"], stage["method"]) for stage in summary["stages"][:3]] == [
            ("inspect", "saved-audio-validation"),
            ("download", "reused-saved-audio"),
            ("decode", "reused-decoded-wav"),
        ]
        assert ("decode", 1, None) in reports
        assert reports.index(("decode", 1, None)) < reports.index(
            ("detect", 0, "Connecting to Azure GPU processing"))
        assert failed["details"]["diagnostics"]["decode"]["method"] == "reused-decoded-wav"
        assert cached.is_file()
    finally:
        runner.close()


def test_cloud_status_is_single_after_decode_and_saved_audio_is_labeled_before_reuse(
        monkeypatch, tmp_path):
    from mizan import cloud

    saved = tmp_path / "saved.wav"
    write_audio(saved, fixture_audio())
    metadata = {"title": "Saved study", "duration": 8, "videoId": "aB_12-cD345",
                "source": URL, "thumbnail": None}
    reports = []
    status_calls = []
    monkeypatch.setattr(pipeline, "app_dir", lambda name: tmp_path / name)
    (tmp_path / "tmp").mkdir()
    (tmp_path / "cache").mkdir()

    def report(stage, progress, **kwargs):
        reports.append((stage, progress, kwargs.get("message")))

    def status():
        assert reports[-1] == ("detect", 0, "Connecting to Azure GPU processing")
        assert ("decode", 1, None) in reports
        status_calls.append("status")
        return {"available": True, "configured": True}

    def reuse(_job, output, cancelled):
        assert reports[-1] == ("inspect", 0, "Validating saved audio")
        pipeline.copy_decoded(saved, output, cancelled)
        return metadata, [], saved

    monkeypatch.setattr(cloud, "status", status)
    monkeypatch.setattr(cloud, "offload",
                        lambda *args: (_ for _ in ()).throw(cloud.CloudError("offline")))
    monkeypatch.setattr(pipeline, "_reuse_recording", reuse)
    monkeypatch.setattr(pipeline, "preflight", lambda *args: [])
    job = {"id": str(uuid4()), "url": URL, "instrument": "piano", "song_id": "saved-song",
           "details": {"processingMode": "cloud"}}

    with pytest.raises(cloud.CloudError, match="offline"):
        pipeline.run_pipeline(job, report, Event())

    assert status_calls == ["status"]
    assert ("inspect", 0, "Validating saved audio") in reports
    assert ("decode", 1, None) in reports
    assert reports.index(("decode", 1, None)) < reports.index(
        ("detect", 0, "Connecting to Azure GPU processing"))


def test_cloud_decode_failure_stays_in_decode_and_skips_azure(monkeypatch, tmp_path):
    from mizan import cloud

    monkeypatch.setattr(pipeline, "app_dir", lambda name: tmp_path / name)
    (tmp_path / "tmp").mkdir()
    (tmp_path / "cache").mkdir()
    fake_ingestion(monkeypatch)
    monkeypatch.setattr(cloud, "status",
                        lambda: pytest.fail("Azure was contacted after a decode failure"))
    monkeypatch.setattr(pipeline, "decode",
                        lambda *args: (_ for _ in ()).throw(UnsupportedMedia("bad audio")))
    reports = []
    job = {"id": str(uuid4()), "url": URL, "instrument": "piano",
           "details": {"processingMode": "cloud"}}

    with pytest.raises(UnsupportedMedia, match="bad audio"):
        pipeline.run_pipeline(
            job, lambda stage, progress, **kwargs: reports.append(
                (stage, progress, kwargs.get("message"))), Event())

    assert reports[-1] == ("decode", 0, None)
    assert not any(stage == "detect" for stage, _, _ in reports)


def test_ordinary_metadata_inspection_keeps_reading_video_message(monkeypatch, tmp_path):
    monkeypatch.setattr(pipeline, "app_dir", lambda name: tmp_path / name)
    (tmp_path / "tmp").mkdir()
    (tmp_path / "cache").mkdir()
    monkeypatch.setattr("mizan.engine.muscriptor.prepare_model", lambda *args: None)
    monkeypatch.setattr(pipeline, "_reuse_recording", lambda *args: (None, [], None))
    monkeypatch.setattr(pipeline, "ffmpeg_path", lambda: "test-ffmpeg")
    reports = []

    def report(stage, progress, **kwargs):
        reports.append((stage, progress, kwargs.get("message")))

    def inspect(*args):
        assert reports[-1] == ("inspect", 0.8, "Reading video details")
        raise RuntimeError("stop after checking metadata phase")

    monkeypatch.setattr(pipeline, "inspect_video", inspect)
    job = {"id": str(uuid4()), "url": URL, "instrument": "piano", "details": {}}
    with pytest.raises(RuntimeError, match="stop after checking metadata phase"):
        pipeline.run_pipeline(job, report, Event())


def test_cloud_result_uses_gpu_stems_and_both_note_passes_without_local_models(monkeypatch, tmp_path):
    audio = fixture_audio()
    write_audio(tmp_path / "original.wav", audio)
    for name in ("piano", "drums", "vocals", "guitar", "bass", "other"):
        write_audio(tmp_path / f"{name}.wav", audio if name in ("piano", "drums", "vocals")
                    else Audio(np.zeros_like(audio.samples), audio.rate))
    monkeypatch.setattr(pipeline, "_demucs", lambda *args: pytest.fail("Local separation ran"))
    monkeypatch.setattr("mizan.engine.muscriptor.transcribe_official",
                        lambda *args, **kwargs: pytest.fail("Local transcription ran"))
    notes = [{"instrument": "voice", "midi": 60, "onset": 0.5, "offset": 1.0}]
    details = {"method": "muscriptor-small-pytorch-cuda",
               "model": {"id": "muscriptor-small", "version": "verified"},
               "provider": {"effectiveProviders": ["PyTorch CUDA"]}, "warnings": []}
    cloud_result = {
        "separation": {"method": "htdemucs-6s-onnx",
                       "model": {"id": "htdemucs-6s-fp16weights", "version": "verified"},
                       "provider": {"effectiveProviders": ["CUDAExecutionProvider"]}, "warnings": []},
        "mix": ([], [], details, notes),
        "vocals": ([], [], details, notes),
    }
    song = pipeline.analyze_decoded(
        tmp_path / "original.wav", tmp_path, title="Synthetic study", url=URL,
        instrument="auto", report=lambda *args: None, cancelled=Event(),
        cloud_result=cloud_result)
    assert song["diagnostics"]["separate"]["provider"]["effectiveProviders"] == ["CUDAExecutionProvider"]
    assert song["diagnostics"]["separate"]["seconds"] is None
    assert song["diagnostics"]["detect"]["provider"]["effectiveProviders"] == ["CPU-DSP"]
    assert song["diagnostics"]["transcribe"]["provider"]["effectiveProviders"] == ["PyTorch CUDA"]
    assert song["diagnostics"]["transcribe"]["seconds"] is None
    assert "not reported" in song["diagnostics"]["transcribe"]["timingNote"]
    assert any(track["id"] == "vocals" for track in song["tracks"])


def test_cloud_blobs_deleted_only_after_song_is_saved(monkeypatch):
    from mizan import cloud
    from types import SimpleNamespace
    fake_ingestion(monkeypatch)
    clock = [10.0]
    monkeypatch.setattr(pipeline, "time",
                        SimpleNamespace(perf_counter=lambda: clock[0]))
    pipeline_events = []
    for name in ("inspect_video", "download_video", "decode"):
        original = getattr(pipeline, name)
        def record_local_step(*args, _name=name, _original=original, **kwargs):
            pipeline_events.append(_name.removesuffix("_video"))
            return _original(*args, **kwargs)
        monkeypatch.setattr(pipeline, name, record_local_step)
    monkeypatch.setattr(cloud, "selected", lambda: True)
    monkeypatch.setattr(cloud, "status",
                        lambda: {"available": True, "configured": True})
    monkeypatch.setattr(pipeline, "_demucs", lambda *args: pytest.fail("Local separation ran"))
    monkeypatch.setattr("mizan.engine.muscriptor.transcribe_official",
                        lambda *args, **kwargs: pytest.fail("Local transcription ran"))
    notes = [{"instrument": "voice", "midi": 60, "onset": 0.5, "offset": 1.0}]
    details = {"method": "muscriptor-small-pytorch-cuda",
               "model": {"id": "muscriptor-small", "version": "verified"},
               "provider": {"effectiveProviders": ["PyTorch CUDA"]}, "warnings": []}
    local_harmony = pipeline.analyze_harmony

    def analyze_harmony_on_host(*args, **kwargs):
        assert pipeline_events == ["inspect", "download", "decode", "offload"]
        pipeline_events.append("chords")
        return local_harmony(*args, **kwargs)

    monkeypatch.setattr(pipeline, "analyze_harmony", analyze_harmony_on_host)
    remote = {
        "separation": {"method": "htdemucs-6s-onnx",
                       "model": {"id": "htdemucs-6s-fp16weights", "version": "verified"},
                       "provider": {"effectiveProviders": ["CUDAExecutionProvider"]}, "warnings": []},
        "mix": ([], [], details, notes), "vocals": ([], [], details, notes),
    }
    files = ["jobs/test/input.wav"]
    def offload(recording, directory, model, cancelled, report):
        assert recording.name == "original.wav" and recording.is_file()
        assert model == "muscriptor-small"
        pipeline_events.append("offload")
        audio = read_audio(recording)
        for name in ("piano", "drums", "vocals", "guitar", "bass", "other"):
            write_audio(directory / f"{name}.wav", audio)
        clock[0] += 2.5  # Simulate Azure execution plus host-side materialization.
        return remote, files

    monkeypatch.setattr(cloud, "offload", offload)
    saved_at_cleanup = []
    cleanup_complete = Event()
    runner = JobRunner(JobStore())
    def cleanup(names):
        done = next(job for job in runner.store.list() if job["details"].get("cloudFiles") == names)
        assert done["status"] == "done"
        entry = runner.library.get(done["song_id"])
        assert Path(entry["song_path"]).is_file()
        assert all(Path(path).is_file() for path in entry["artifacts"].values())
        saved_at_cleanup.append(names)
        cleanup_complete.set()

    monkeypatch.setattr(cloud, "cleanup", cleanup)
    try:
        job = runner.start(URL, "piano")
        done = wait_for(runner.store, job["id"], "done")
        assert pipeline_events == ["inspect", "download", "decode", "offload", "chords"]
        assert all(name in done["details"]["diagnostics"]
                   for name in ("inspect", "download", "decode", "separate", "transcribe",
                                "chords", "notation", "finalize", "cloudRoundTrip"))
        assert done["details"]["diagnostics"]["cloudRoundTrip"]["seconds"] == pytest.approx(2.5)
        assert done["details"]["cloudElapsedSeconds"] == pytest.approx(2.5)
        assert "host-side materialization" in \
            done["details"]["diagnostics"]["cloudRoundTrip"]["timingNote"]
        assert cleanup_complete.wait(5)
        assert saved_at_cleanup == [files]
        for _ in range(100):
            if not runner.store.get(done["id"])["details"].get("cloudFiles"):
                break
            time.sleep(0.05)
        assert not runner.store.get(done["id"])["details"].get("cloudFiles")
        assert done["song_id"]
        assert all(Path(done["details"]["artifacts"][name]).is_file()
                   for name in ("analysis", "midi", "musicxml", "original"))
    finally:
        runner.close()


def test_failed_library_save_keeps_cloud_files_for_recovery(monkeypatch):
    from mizan import cloud
    monkeypatch.setattr(cloud, "selected", lambda: True)
    monkeypatch.setattr(cloud, "cleanup", lambda names: pytest.fail("Uncommitted Cloud files deleted"))
    files = ["jobs/test/input.wav"]
    store = JobStore()
    runner = JobRunner(store, pipeline=lambda job, report, cancelled:
                       {"cloudFiles": files, "artifacts": {"analysis": "missing.json"}})
    monkeypatch.setattr(runner.library, "upsert_job",
                        lambda *args: (_ for _ in ()).throw(OSError("disk unavailable")))
    try:
        job = runner.start(URL, "piano")
        failed = wait_for(store, job["id"], "failed")
        assert failed["details"]["cloudFiles"] == files
        assert "Could not save" in failed["error_message"]
    finally:
        runner.close()


def test_failed_cloud_analysis_deletes_outputs_after_job_stops(monkeypatch):
    from mizan import cloud
    from mizan.errors import MizanError

    monkeypatch.setattr(cloud, "selected", lambda: True)
    removed = []
    monkeypatch.setattr(cloud, "cleanup", lambda names: removed.append(names))
    files = ["jobs/test/input.wav"]

    def failing_pipeline(job, report, cancelled):
        job["details"]["cloudFiles"] = files
        raise MizanError("Cloud analysis failed after download.")

    runner = JobRunner(JobStore(), pipeline=failing_pipeline)
    try:
        job = runner.start(URL, "piano")
        failed = wait_for(runner.store, job["id"], "failed")
        for _ in range(100):
            if removed and not runner.store.get(failed["id"])["details"].get("cloudFiles"):
                break
            time.sleep(0.05)
        assert removed == [files]
        assert not runner.store.get(failed["id"])["details"].get("cloudFiles")
    finally:
        runner.close()


def test_cancel_cleans_partial_outputs(monkeypatch):
    fake_ingestion(monkeypatch)
    fake_models(monkeypatch)
    event = Event()
    job = {"id": str(uuid4()), "url": URL, "instrument": "drums"}

    def report(stage, progress, **_kwargs):
        if stage == "transcribe":
            event.set()
            raise Cancelled()

    with pytest.raises(Cancelled):
        pipeline.run_pipeline(job, report, event)
    assert not (app_dir("tmp") / job["id"]).exists()
    assert not (app_dir("cache") / job["id"]).exists()


def test_silent_contract_and_midi(tmp_path):
    audio = Audio(np.zeros(22050), 22050)
    harmony = analyze_harmony(audio)
    song = build_song("Silence", URL, 1, harmony, [], [], {})
    assert song["tracks"] == [] and song["accompaniment"] == []
    path = tmp_path / "silence.mid"
    export_midi(song, path)
    assert len(mido.MidiFile(path).tracks) == 1
    json.dumps(song, allow_nan=False)
    assert quantize(0.51, 120) == 1.0
    assert quantize(0.55, 120) == 1.1


def test_decode_actual_ffmpeg_and_metadata_preflight(tmp_path):
    try:
        ffmpeg_path()
    except UnsupportedMedia:
        pytest.skip("FFmpeg is not installed on this test machine.")
    source, output = tmp_path / "source.wav", tmp_path / "decoded.wav"
    write_audio(source, Audio(synth_chord([60], rate=16000), 16000))
    decode(source, output, Event())
    audio = read_audio(output)
    assert audio.rate == 22050 and audio.samples.shape == (44100, 2)
    assert preflight({"duration": 1300}, tmp_path)
    with pytest.raises(InsufficientDisk):
        preflight({"duration": 1e12}, tmp_path)


def test_direct_audio_403_retries_hls_without_hiding_other_failures(monkeypatch, tmp_path):
    formats = []
    source = tmp_path / "source.mp4"
    source.write_bytes(b"audio")

    def download(command, *_):
        formats.append(command[command.index("-f") + 1])
        if len(formats) == 1:
            raise DownloadFailed("HTTP Error 403: Forbidden")
        return str(source)

    monkeypatch.setattr(media, "run_command", download)
    assert media.download_video(URL, tmp_path, Event()) == source
    assert formats == ["bestaudio/best", "bestaudio[protocol^=m3u8]/best[protocol^=m3u8]"]

    def denied(*_):
        raise DownloadFailed("HTTP Error 429: Too Many Requests")

    monkeypatch.setattr(media, "run_command", denied)
    with pytest.raises(DownloadFailed, match="429"):
        media.download_video(URL, tmp_path, Event())


def test_drum_midi_export_keeps_detected_gm_pitch_only_when_it_matches_the_lane(tmp_path):
    from mizan.engine.drums import gm_pitch
    assert gm_pitch({"lane": "hightom", "sourceMidi": 47}) == 47
    assert gm_pitch({"lane": "hihat", "sourceMidi": 44}) == 44
    assert gm_pitch({"lane": "hightom"}) == 48
    # A pitch from another lane, or a non-integer, never overrides the lane.
    assert gm_pitch({"lane": "snare", "sourceMidi": 47}) == 38
    assert gm_pitch({"lane": "floortom", "sourceMidi": 43.0}) == 41
    harmony = analyze_harmony(Audio(np.zeros(22050 * 4), 22050))
    drums = [{"lane": lane, "onset": onset, "velocity": 0.6, "confidence": 0.4, "possibleLanes": [lane], **extra}
             for lane, onset, extra in [("hightom", 0.5, {"sourceMidi": 50}), ("floortom", 1.0, {"sourceMidi": 43}),
                                        ("hihat", 1.5, {"sourceMidi": 44}), ("kick", 2.0, {})]]
    song = build_song("Kit", URL, 4, harmony, [], drums, {})
    assert [hit.get("sourceMidi") for hit in song["drums"]] == [50, 43, 44, None]
    path = tmp_path / "kit.mid"
    export_midi(song, path)
    pitches = [message.note for track in mido.MidiFile(path).tracks for message in track
               if message.type == "note_on" and message.velocity and message.channel == 9]
    assert pitches == [50, 43, 44, 36]
