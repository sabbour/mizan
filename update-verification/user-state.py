import argparse
import hashlib
import json
import os
import sqlite3
from pathlib import Path


def digest(data):
    return hashlib.sha256(data).hexdigest()


def encode(value):
    if isinstance(value, bytes):
        return {"bytes": value.hex()}
    return value


def snapshot():
    home = Path(os.environ["LOCALAPPDATA"]) / "Mizan"
    database = home / "mizan.db"
    cache = home / "cache"
    if not database.is_file() or not cache.is_dir():
        raise RuntimeError("The installed application's database or cache is missing")
    tables = {}
    with sqlite3.connect(database.as_uri() + "?mode=ro", uri=True) as connection:
        connection.execute("PRAGMA query_only = ON")
        connection.execute("BEGIN")
        schema = [list(row) for row in connection.execute(
            "SELECT type, name, tbl_name, sql FROM sqlite_master "
            "WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"
        )]
        for name, in connection.execute(
            "SELECT name FROM sqlite_master WHERE type='table' "
            "AND name NOT LIKE 'sqlite_%' ORDER BY name"
        ):
            identifier = '"' + name.replace('"', '""') + '"'
            columns = [list(row) for row in connection.execute(f"PRAGMA table_info({identifier})")]
            rows = [
                json.dumps([encode(value) for value in row], separators=(",", ":"), ensure_ascii=True, allow_nan=False)
                for row in connection.execute(f"SELECT * FROM {identifier}")
            ]
            rows.sort()
            tables[name] = {"columns": columns, "count": len(rows), "rows_sha256": digest(json.dumps(rows).encode())}
    files = {
        str(path.relative_to(cache)): digest(path.read_bytes())
        for path in sorted(cache.rglob("*")) if path.is_file()
    }
    window = home / "window.json"
    return {
        "schema": schema,
        "tables": tables,
        "cache_files": files,
        "window_sha256": digest(window.read_bytes()) if window.is_file() else None,
    }


parser = argparse.ArgumentParser()
parser.add_argument("output", type=Path)
parser.add_argument("--before", type=Path)
args = parser.parse_args()
state = snapshot()
args.output.write_text(json.dumps(state, indent=2), encoding="utf-8")
print(f"Saved read-only fingerprint: {len(state['tables'])} tables, {len(state['cache_files'])} cache files")
if args.before:
    before = json.loads(args.before.read_text(encoding="utf-8"))
    changed = [key for key in state if before.get(key) != state[key]]
    if changed:
        raise RuntimeError("Installed update changed saved state: " + ", ".join(changed))
    print("Full schema, every database row, every cache file and saved window state are unchanged")
