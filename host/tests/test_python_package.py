import json
from importlib import metadata

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
