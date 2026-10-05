import numpy as np
import pytest

from mizan.engine.muscriptor_fp16_spike import compare, run_decoder


def test_compare_requires_full_eos_and_matching_notes():
    cpu = {"fixtureSha256": "input", "modelSha256": {"decoder": "same"},
           "tokens": [1134, 54, 1], "notes": [{"midi": 76}], "eosReached": True}
    assert compare(cpu, dict(cpu)) == {
        "sharedPrefixTokens": 3, "tokenStreamsIdentical": True,
        "noteEventsIdentical": True, "parityComplete": True,
    }
    partial = {**cpu, "tokens": [1134, 55], "eosReached": False}
    assert compare(cpu, partial)["sharedPrefixTokens"] == 1
    assert not compare(cpu, partial)["parityComplete"]
    with pytest.raises(ValueError, match="different input"):
        compare(cpu, {**cpu, "fixtureSha256": "different"})


def test_decoder_rejects_non_fp16_condition_before_inference():
    with pytest.raises(ValueError, match="FP16 condition"):
        run_decoder(None, np.zeros((1, 502, 1024), dtype=np.float32), 16, 10)


def test_decoder_feeds_growing_fp16_caches_and_stops_at_eos():
    class FakeSession:
        calls = 0

        def run(self, _, feed):
            self.calls += 1
            assert feed["condition_embeds"].shape[1] == (2 if self.calls == 1 else 0)
            assert feed["past_key_values.0.key"].shape[2] == (0 if self.calls == 1 else 3)
            logits = np.zeros((1, 1, 1395), np.float32)
            logits[0, 0, 1134 if self.calls == 1 else 1] = 1
            caches = [np.zeros((1, 16, 2 + self.calls, 64), np.float16) for _ in range(48)]
            return [logits, *caches]

    session = FakeSession()
    tokens, report = run_decoder(session, np.zeros((1, 2, 1024), np.float16), 4, 5)
    assert tokens == [1134]
    assert report["eosReached"] and session.calls == 2
