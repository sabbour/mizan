import json
import sqlite3

from mizan.library import LibraryStore, public_entry


def _columns(path):
    with sqlite3.connect(path) as connection:
        return [(row[1], row[2]) for row in connection.execute("PRAGMA table_info(songs)")]


def test_startup_keeps_an_existing_library_schema_and_rows(tmp_path):
    database = tmp_path / "mizan.db"
    store = LibraryStore(database)
    analysis = tmp_path / "old" / "analysis.json"
    analysis.parent.mkdir()
    analysis.write_text(json.dumps({"tracks": []}), encoding="utf-8")
    store.create_import("Old song", "midi", {"tracks": []}, {"analysis": str(analysis)}, "1")
    before = _columns(database)
    with sqlite3.connect(database) as connection:
        rows_before = connection.execute("SELECT * FROM songs ORDER BY id").fetchall()
    LibraryStore(database)
    assert _columns(database) == before
    assert not {"license", "attribution"} & {name for name, _ in before}
    with sqlite3.connect(database) as connection:
        assert connection.execute("SELECT * FROM songs ORDER BY id").fetchall() == rows_before


def test_license_and_attribution_survive_saving_and_reopening(tmp_path):
    store = LibraryStore(tmp_path / "mizan.db")
    analysis = tmp_path / "song" / "analysis.json"
    analysis.parent.mkdir()
    analysis.write_text(json.dumps({"tracks": []}), encoding="utf-8")
    saved = store.create_import("Ut queant laxis", "midi", {"tracks": []}, {"analysis": str(analysis)}, "1",
                                entry_metadata={"license": "CC0", "attribution": "Guido von Arezzo",
                                                "provider": "Internet Archive", "sourceUrl": "https://archive.org/details/x"})
    reopened = LibraryStore(tmp_path / "mizan.db").get(saved["id"])
    entry = public_entry(reopened, "1")
    assert entry["license"] == "CC0" and entry["attribution"] == "Guido von Arezzo"
    assert entry["sourceUrl"] == "https://archive.org/details/x"
    assert json.loads((analysis.parent / "source.json").read_text(encoding="utf-8"))["provider"] == "Internet Archive"
    plain = store.create_import("Own file", "midi", {"tracks": []}, {"analysis": str(analysis)}, "1")
    assert public_entry(store.get(plain["id"]), "1")["license"] is None
