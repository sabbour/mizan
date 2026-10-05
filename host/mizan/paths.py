import os
from pathlib import Path


def home() -> Path:
    override = os.environ.get("MIZAN_HOME")
    path = Path(override) if override else Path(os.environ["LOCALAPPDATA"]) / "Mizan"
    path.mkdir(parents=True, exist_ok=True)
    return path


def app_dir(name: str) -> Path:
    if name not in ("downloads", "cache", "logs", "tmp", "models"):
        raise ValueError(f"Unknown app directory: {name}")
    override = os.environ.get("MIZAN_MODELS_DIR") if name == "models" else None
    path = Path(override) if override else home() / name
    path.mkdir(parents=True, exist_ok=True)
    return path
