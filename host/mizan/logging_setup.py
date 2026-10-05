import json
import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path

from .paths import app_dir

logger = logging.getLogger(__name__)
BUILD_INFO_PATH = Path(__file__).with_name("build_info.json")
MAX_LOG_BYTES = 5 * 1024 * 1024
LOG_BACKUP_COUNT = 3
_HANDLER_NAME = "mizan-file"
_LOG_FORMAT = "%(asctime)s %(levelname)s %(name)s: %(message)s"


def _build_identity() -> tuple[str, str]:
    if not BUILD_INFO_PATH.is_file():
        return "development", "source"
    info = json.loads(BUILD_INFO_PATH.read_text(encoding="utf-8"))
    version, build_id = info.get("version"), info.get("buildId")
    if not isinstance(version, str) or not isinstance(build_id, str):
        raise ValueError("Packaged build identity is invalid.")
    return version, build_id


def configure_file_logging() -> None:
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    for handler in tuple(root.handlers):
        if handler.get_name() == _HANDLER_NAME:
            root.removeHandler(handler)
            handler.close()

    handler = RotatingFileHandler(
        app_dir("logs") / "mizan.log",
        maxBytes=MAX_LOG_BYTES,
        backupCount=LOG_BACKUP_COUNT,
        encoding="utf-8",
    )
    handler.set_name(_HANDLER_NAME)
    handler.setLevel(logging.INFO)
    handler.setFormatter(logging.Formatter(_LOG_FORMAT))
    root.addHandler(handler)
    logger.info("File logging enabled path=%s max_bytes=%d backups=%d",
                handler.baseFilename, MAX_LOG_BYTES, LOG_BACKUP_COUNT)
    version, build_id = _build_identity()
    logger.info("Mizan startup version=%s build_id=%s", version, build_id)
