from types import SimpleNamespace
from unittest.mock import MagicMock, Mock

import pytest

import mizan.engine.muscriptor_large_spike as spike
from mizan.engine.muscriptor_large_spike import check_model, notes_from_events


def test_large_events_pair_by_index_and_keep_drum_hits():
    start = SimpleNamespace(index=7, start_time=0.5, pitch=60, instrument="acoustic_piano")
    drum = SimpleNamespace(index=8, start_time=1.0, pitch=36, instrument="drums")
    events = [
        start, drum,
        SimpleNamespace(start_event_index=8, end_time=1.01),
        SimpleNamespace(start_event_index=7, end_time=2.0),
    ]
    assert notes_from_events(events) == [
        {"instrument": "acoustic_piano", "midi": 60, "onset": 0.5, "offset": 2.0},
        {"instrument": "drums", "midi": 36, "onset": 1.0, "offset": 1.01},
    ]
    with pytest.raises(RuntimeError, match="Unclosed notes"):
        notes_from_events([start])


def test_rejects_wrong_checkpoint_before_loading_torch():
    weights = Mock()
    weights.is_file.return_value = True
    weights.stat.return_value.st_size = 12
    config = Mock()
    config.is_file.return_value = True
    model_dir = MagicMock()
    model_dir.__truediv__.side_effect = lambda filename: (
        weights if filename == "model.safetensors" else config
    )
    with pytest.raises(ValueError, match="size mismatch"):
        check_model(model_dir)


def test_existing_weights_do_not_trigger_download_or_require_token(monkeypatch):
    weights, config, model_dir = Mock(), Mock(), MagicMock()
    weights.exists.return_value = True
    weights.stat.return_value.st_size = spike.WEIGHTS_BYTES
    config.is_file.return_value = True
    model_dir.__truediv__.side_effect = lambda filename: (
        weights if filename == "model.safetensors" else config
    )
    monkeypatch.setattr("mizan.hf_credentials.get_hf_token",
                        lambda: pytest.fail("No token lookup for cached weights"))
    spike.download(model_dir)
