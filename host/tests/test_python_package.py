import json
import os
import shutil
import subprocess
from importlib import metadata
from pathlib import Path
from types import SimpleNamespace

import pytest
from packaging.requirements import Requirement

from scripts import credits, package_python


@pytest.mark.parametrize(("platform", "machine", "wheel"), [
    ("win32", "x86_64", "win_amd64.whl"),
    ("win32", "AMD64", "win_amd64.whl"),
    ("win32", "ARM64", "win_arm64.whl"),
    ("linux", "x86_64", None),
])
def test_torch_pin_matches_the_windows_resolver_target(platform, machine, wheel):
    environment = {"sys_platform": platform, "platform_machine": machine}
    requirements = map(Requirement, package_python.project_config()["project"]["dependencies"])
    urls = [
        req.url.split("#")[0] for req in requirements
        if req.name == "torch" and req.marker.evaluate(environment)
    ]
    assert len(urls) == (0 if wheel is None else 1)
    if wheel:
        assert urls[0].endswith(wheel)


@pytest.mark.parametrize(("platform", "reported_machine", "arch"), [
    ("win-amd64", "ARM64", "x64"),
    ("win-amd64", "AMD64", "x64"),
    ("win-arm64", "ARM64", "arm64"),
])
def test_production_markers_use_python_architecture(monkeypatch, platform, reported_machine, arch):
    dependencies = [
        "torch-arm64; platform_machine == 'ARM64'",
        "torch-x64; platform_machine == 'AMD64'",
    ]
    root = f"torch-{arch}"
    distributions = [
        SimpleNamespace(metadata={"Name": root}, requires=[
            "native-arm64; platform_machine == 'ARM64'",
            "native-x64; platform_machine == 'AMD64'",
        ]),
        SimpleNamespace(metadata={"Name": f"native-{arch}"}, requires=[]),
    ]
    monkeypatch.setattr(package_python, "project_config", lambda: {"project": {"dependencies": dependencies}})
    monkeypatch.setattr(package_python, "sysconfig_platform", lambda: platform)
    monkeypatch.setattr(package_python, "default_environment", lambda: {"platform_machine": reported_machine})
    monkeypatch.setattr(metadata, "distributions", lambda: distributions)

    expected = {root, f"native-{arch}"}
    assert {dist.metadata["Name"] for dist in package_python.production_distributions()} == expected
    assert credits.production_python_names() == expected | {"muscriptor"}


def test_production_stage_includes_cpu_inference_without_gated_weights(tmp_path):
    distributions = {dist.metadata["Name"].lower().replace("_", "-"): dist
                     for dist in package_python.production_distributions()}
    assert distributions["torch"].version == "2.14.0+cpu"
    assert {"safetensors", "einops", "huggingface-hub", "packaging", "mido"} <= distributions.keys()
    assert distributions["yt-dlp"].version == "2026.11.23"
    assert distributions["yt-dlp-ejs"].version == "0.8.0"
    assert "muscriptor" not in distributions

    package_python.copy_muscriptor_source(tmp_path)
    assert (tmp_path / "muscriptor" / "transcription_model.py").is_file()
    assert (tmp_path / "muscriptor" / "LICENSE").is_file()
    assert not list(tmp_path.rglob("*.safetensors"))


def test_msix_bundles_checksum_pinned_node_runtime():
    build_script = (
        Path(__file__).resolve().parents[2] / "scripts" / "Build-Msix.ps1"
    ).read_text(encoding="utf-8")

    assert 'nodeVersion = "24.22.0"' in build_script
    assert "node-v24.22.0-win-arm64.zip" in build_script
    assert "node-v24.22.0-win-x64.zip" in build_script
    assert "Get-FileHash -Path $archivePath -Algorithm SHA256" in build_script
    assert 'Join-Path $Destination "js-runtime"' in build_script


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
