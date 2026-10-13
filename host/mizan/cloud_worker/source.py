"""Source contract for building the bundled GPU worker image."""

import hashlib
from pathlib import Path

WORKER_SOURCE_FILES = ("Dockerfile", "worker.py", "storage.py", "LICENSE")
LEGACY_AZURE_SOURCE_HASH = "88d8227cfcd0c2668c08d224f02a7494c277c889d154008836a5faadba5eeb93"


def worker_source() -> tuple[dict[str, bytes], str]:
    directory = Path(__file__).parent
    files = {name: (directory / name).read_bytes() for name in WORKER_SOURCE_FILES}
    dockerfile = files["Dockerfile"]
    if (not files["worker.py"] or len(files["worker.py"]) > 2 * 1024 * 1024
            or not files["storage.py"] or len(files["storage.py"]) > 64 * 1024
            or not files["LICENSE"] or len(files["LICENSE"]) > 64 * 1024
            or len(dockerfile) > 64 * 1024
            or b"COPY worker.py /app/worker.py" not in dockerfile
            or b"COPY storage.py /app/storage.py" not in dockerfile
            or b"COPY LICENSE /app/LICENSE" not in dockerfile
            or b'ENTRYPOINT ["python", "/app/worker.py"]' not in dockerfile):
        raise ValueError("Bundled GPU worker source does not satisfy the Docker build contract.")
    digest = hashlib.sha256(b"Mizan bundled worker v2\0")
    for name, content in files.items():
        digest.update(name.encode("ascii") + b"\0" + content + b"\0")
    return files, digest.hexdigest()
