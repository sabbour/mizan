"""Opt-in end-to-end check against the existing private Azure GPU pilot."""

import json
import os
import shutil
import subprocess
import time
from pathlib import Path

import numpy as np
import pytest

from mizan import azure_cloud, cloud
from mizan.api import Api
from mizan.cloud_transport import CloudTransport
from mizan.engine import pipeline
from mizan.engine.audio import Audio, read_audio, write_audio
from mizan.jobs import JobRunner, JobStore


@pytest.mark.skipif(not os.environ.get("MIZAN_LIVE_AZURE_CONFIG"), reason="requires an authorized Azure pilot")
def test_live_gpu_job_imports_and_saves_song_then_removes_blobs(monkeypatch, tmp_path):
    config = azure_cloud._validate(json.loads(os.environ["MIZAN_LIVE_AZURE_CONFIG"]))
    monkeypatch.setenv("MIZAN_HOME", str(tmp_path / "library"))
    monkeypatch.setattr(cloud, "_setting", lambda key: {
        "cloud_config": json.dumps(config), "cloud_provider": "azure",
        "processing_mode": "cloud",
    }.get(key))
    monkeypatch.setattr(azure_cloud, "status",
                        lambda **_kwargs: {"available": True, "configured": True})
    monkeypatch.setattr(azure_cloud, "_setting",
                        lambda key: json.dumps(config) if key == "cloud_config" else None)

    def cli_token(self, scope):
        resource = scope.removesuffix(".default")
        result = subprocess.run(
            [shutil.which("az") or "az", "account", "get-access-token", "--resource", resource,
             "--query", "accessToken", "-o", "tsv"],
            capture_output=True, text=True, check=True,
        )
        return result.stdout.strip()

    monkeypatch.setattr(CloudTransport, "_token", cli_token)
    recording = tmp_path / "synthetic.wav"
    rate = 16000
    samples = (0.03 * np.sin(2 * np.pi * 261.63 * np.arange(rate * 8) / rate)).astype(np.float32)
    write_audio(recording, Audio(samples, rate))
    monkeypatch.setattr(pipeline, "ffmpeg_path", lambda: "unused-for-wav-test")
    monkeypatch.setattr(pipeline, "inspect_video", lambda url, work, event: {
        "title": "Synthetic C4 Cloud integration", "duration": 8,
        "videoId": "aB_12-cD345", "source": url, "thumbnail": None,
    })
    monkeypatch.setattr(pipeline, "download_video", lambda url, work, event, progress: recording)
    monkeypatch.setattr(pipeline, "decode", lambda source, output, event: shutil.copyfile(source, output))
    monkeypatch.setattr(pipeline, "_demucs", lambda *args: pytest.fail("Cloud used local separator"))
    monkeypatch.setattr("mizan.engine.muscriptor.transcribe_official",
                        lambda *args, **kwargs: pytest.fail("Cloud used local transcription"))

    runner = JobRunner(JobStore())
    try:
        job = runner.start("https://www.youtube.com/watch?v=aB_12-cD345", "piano")
        deadline = time.monotonic() + 900
        while time.monotonic() < deadline:
            done = runner.store.get(job["id"])
            if done["status"] in ("done", "failed", "cancelled"):
                break
            time.sleep(3)
        else:
            pytest.fail("GPU Job did not finish within 15 minutes")
        assert done["status"] == "done", done.get("error_message")
        cleanup_deadline = time.monotonic() + 120
        while "cloudFiles" in done["details"] and time.monotonic() < cleanup_deadline:
            time.sleep(2)
            done = runner.store.get(job["id"])
        assert done["song_id"] and "cloudFiles" not in done["details"]
        opened = Api(runner).open_result(job["id"])
        assert opened["ok"] and opened["song"]["diagnostics"]["separate"]["provider"]["effectiveProviders"] == [
            "CUDAExecutionProvider"]
        assert opened["song"]["diagnostics"]["transcribe"]["provider"]["effectiveProviders"] == ["PyTorch CUDA"]
        for name in ("original", "analysis", "midi", "musicxml"):
            assert Path(done["details"]["artifacts"][name]).is_file()
        assert len(read_audio(Path(done["details"]["artifacts"]["original"])).samples) == rate * 8
        assert runner.library.get(done["song_id"])["title"] == "Synthetic C4 Cloud integration"
    finally:
        runner.close()
