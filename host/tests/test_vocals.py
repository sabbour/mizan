import json
from concurrent.futures import ThreadPoolExecutor
from threading import Event

from mizan.api import Api
from mizan.engine.vocals import clean_melody
from mizan.jobs import JobRunner, JobStore
from test_jobs import URL, wait_for


def test_cleanup_monophony_gaps_confidence_and_no_hands():
    raw = [
        {"midi": 60, "onset": 0.2, "offset": 1.15, "confidence": 0.85, "hand": "right"},
        {"midi": 72, "onset": 0.5, "offset": 1.0, "confidence": 0.4},
        {"midi": 60, "onset": 1.2, "offset": 2.05, "confidence": 0.8},
        {"midi": 64, "onset": 2.1, "offset": 2.8, "confidence": 0.9},
        {"midi": 67, "onset": 2.85, "offset": 3.75, "confidence": 0.8},
    ]
    saved = json.dumps(raw)
    notes = clean_melody(raw)
    assert [note["midi"] for note in notes] == [60, 64, 67]
    assert notes[0]["onset"] == 0.2 and notes[0]["offset"] == 2.05
    assert all(note["offset"] <= later["onset"] for note, later in zip(notes, notes[1:]))
    assert all(note["confidence"] <= 0.49 and "hand" not in note for note in notes)
    assert json.dumps(raw) == saved
    assert clean_melody([{"midi": 30, "onset": 0, "offset": 1, "confidence": 1}]) == []


def test_active_reprocess_is_atomic_across_versions():
    store = JobStore()
    old = store.create("aB_12-cD345", URL, "auto", "old-engine")
    store.update(old["id"], status="running")
    with ThreadPoolExecutor(max_workers=6) as pool:
        jobs = list(pool.map(lambda _: store.create(
            "aB_12-cD345", URL, "auto", "new-engine", song_id="saved-song", reuse=False), range(6)))
    assert {job["id"] for job in jobs} == {old["id"]}
    assert all(job["song_id"] == "saved-song" and job["pipeline_version"] == "old-engine" for job in jobs)
    assert len(store.list_queue()) == 1
    for state in ("done", "failed", "cancelled"):
        store.update(jobs[0]["id"], status=state)
        new = store.create("aB_12-cD345", URL, "auto", "new-engine", song_id="saved-song", reuse=False)
        assert new["id"] != jobs[0]["id"]
        jobs = [new]


def test_reprocess_api_preserves_saved_result_then_updates_same_entry(tmp_path):
    old_path, new_path = tmp_path / "old.json", tmp_path / "new.json"
    old = {"title": "Synthetic study", "tracks": [{"id": "piano", "name": "Piano"}],
           "piano": [], "drums": [], "chords": []}
    old_path.write_text(json.dumps(old))
    fresh = {**old, "tracks": [*old["tracks"], {"id": "vocals", "name": "Vocal melody"}], "vocals": []}
    new_path.write_text(json.dumps(fresh))
    entered, release = Event(), Event()

    def processing(job, report, cancelled):
        entered.set()
        assert release.wait(5)
        return {"artifacts": {"analysis": str(new_path)}}

    runner = JobRunner(JobStore(), processing, pipeline_version="new-vocal-engine")
    try:
        entry = runner.library.upsert_job(
            {"url": URL, "details": {"artifacts": {"analysis": str(old_path)}}}, "old-engine")
        api = Api(runner)
        assert api.open_song(entry["id"])["entry"]["outdated"]
        with ThreadPoolExecutor(max_workers=3) as pool:
            requests = list(pool.map(api.reprocess_song, [entry["id"]] * 3))
        assert entered.wait(3)
        assert all(reply["ok"] for reply in requests)
        assert len({reply["job"]["id"] for reply in requests}) == 1
        assert api.open_song(entry["id"])["song"] == old
        release.set()
        wait_for(runner.store, requests[0]["job"]["id"], "done")
        updated = api.open_song(entry["id"])
        assert not updated["entry"]["outdated"]
        assert updated["song"] == fresh and old_path.exists()
        assert updated["entry"]["parts"] == ["Piano", "Vocal melody"]
        assert len(api.list_library()["entries"]) == 1
    finally:
        release.set()
        runner.close()
