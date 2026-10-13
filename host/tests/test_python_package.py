import json
import os
import shutil
import subprocess
from importlib import metadata
from pathlib import Path

import pytest

from scripts import package_python


def test_production_stage_includes_cpu_inference_without_gated_weights(tmp_path):
    distributions = {dist.metadata["Name"].lower().replace("_", "-"): dist
                     for dist in package_python.production_distributions()}
    assert distributions["torch"].version == "2.14.0+cpu"
    assert {"safetensors", "einops", "huggingface-hub", "packaging", "mido"} <= distributions.keys()
    assert "muscriptor" not in distributions

    package_python.copy_muscriptor_source(tmp_path)
    assert (tmp_path / "muscriptor" / "transcription_model.py").is_file()
    assert (tmp_path / "muscriptor" / "LICENSE").is_file()
    assert not list(tmp_path.rglob("*.safetensors"))


def test_package_rejects_different_official_source_commit(monkeypatch, tmp_path):
    original = metadata.distribution

    class WrongSource:
        version = "0.3.0"

        def read_text(self, name):
            return json.dumps({"vcs_info": {"commit_id": "wrong-commit"}})

    monkeypatch.setattr(metadata, "distribution",
                        lambda name: WrongSource() if name == "muscriptor" else original(name))
    with pytest.raises(RuntimeError, match="pinned Git commit"):
        package_python.copy_muscriptor_source(tmp_path)
    assert not list(tmp_path.iterdir())


def test_package_requires_pinned_official_source(monkeypatch, tmp_path):
    def missing(name):
        raise metadata.PackageNotFoundError(name)

    monkeypatch.setattr(metadata, "distribution", missing)
    with pytest.raises(RuntimeError, match="--no-deps"):
        package_python.copy_muscriptor_source(tmp_path)


def test_msix_workflow_uses_project_version_and_pinned_source_for_pr_builds():
    workflow = (
        Path(__file__).resolve().parents[2] / ".github" / "workflows" / "msix.yml"
    ).read_text(encoding="utf-8")
    source = package_python.project_config()["tool"]["mizan"]["muscriptor-inference-source"]

    assert "  pull_request:" in workflow
    assert "permissions:\n  contents: read" in workflow
    assert '$env:GITHUB_REF_TYPE -eq "tag"' in workflow
    assert "$version = $packageVersion" in workflow
    assert "muscriptor-inference-source" in workflow
    assert "pip install --no-deps $muscriptorSource" in workflow
    assert source not in workflow
    assert '$publisher = "CN=Mizan Development"' in workflow
    assert "-SkipSign" in workflow
    assert (
        "if: github.event_name == 'push' && startsWith(github.ref, 'refs/tags/') "
        "&& vars.MIZAN_BINARY_DISTRIBUTION_READY == 'true'"
    ) in workflow


@pytest.mark.skipif(shutil.which("pwsh") is None, reason="PowerShell 7 is not installed")
@pytest.mark.parametrize("approval, message", [
    (None, "Public installer uploads are blocked."),
    ("false", "Public installer uploads are blocked."),
    ("true", "MSIX was not found:"),
])
def test_public_upload_requires_redistribution_approval(tmp_path, approval, message):
    root = Path(__file__).resolve().parents[2]
    environment = dict(os.environ)
    environment.pop("MIZAN_BINARY_DISTRIBUTION_READY", None)
    if approval is not None:
        environment["MIZAN_BINARY_DISTRIBUTION_READY"] = approval
    result = subprocess.run([
        "pwsh", "-NoProfile", "-NonInteractive", "-File",
        str(root / "scripts" / "Publish-SignedMsix.ps1"),
        "-Version", "0.2.30", "-MsixPath", str(tmp_path / "missing.msix"), "-Upload",
    ], cwd=root, env=environment, capture_output=True, text=True, timeout=30)
    assert result.returncode != 0
    assert message in result.stderr
