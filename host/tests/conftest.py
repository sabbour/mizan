import pytest


@pytest.fixture(autouse=True)
def isolated_home(tmp_path, monkeypatch):
    monkeypatch.setenv("MIZAN_HOME", str(tmp_path / "mizan"))
    monkeypatch.setenv("MIZAN_SEPARATOR", "dsp")
    monkeypatch.setenv("MIZAN_BEATS", "dsp")
