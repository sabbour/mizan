import json
import logging
from logging.handlers import RotatingFileHandler

from mizan import logging_setup


def test_file_logging_uses_bounded_app_log_and_rotates(tmp_path, monkeypatch):
    log_dir = tmp_path / "logs"

    def app_dir(name):
        assert name == "logs"
        log_dir.mkdir(parents=True, exist_ok=True)
        return log_dir

    monkeypatch.setattr(logging_setup, "app_dir", app_dir)
    root = logging.getLogger()
    logging_setup.configure_file_logging()
    handler = next(handler for handler in root.handlers
                   if handler.get_name() == "mizan-file")

    try:
        assert isinstance(handler, RotatingFileHandler)
        assert handler.baseFilename.endswith("mizan.log")
        assert handler.maxBytes == 5 * 1024 * 1024
        assert handler.backupCount == 3

        handler.maxBytes = 128
        logger = logging.getLogger("mizan.logging_test")
        logger.info("before rollover")
        logger.info("x" * 100)
        handler.flush()
        assert "before rollover" in (log_dir / "mizan.log.1").read_text(encoding="utf-8")
        assert "x" * 100 in (log_dir / "mizan.log").read_text(encoding="utf-8")
    finally:
        root.removeHandler(handler)
        handler.close()

    contents = "".join(path.read_text(encoding="utf-8")
                       for path in log_dir.glob("mizan.log*"))
    assert f"File logging enabled path={handler.baseFilename}" in contents


def test_build_identity_reads_packaged_timestamp(tmp_path, monkeypatch):
    path = tmp_path / "build_info.json"
    path.write_text(json.dumps({"version": "0.2.30", "buildId": "20261004T113000Z"}),
                    encoding="utf-8")
    log_dir = tmp_path / "logs"
    log_dir.mkdir()
    monkeypatch.setattr(logging_setup, "BUILD_INFO_PATH", path)
    monkeypatch.setattr(logging_setup, "app_dir", lambda name: log_dir)

    root = logging.getLogger()
    logging_setup.configure_file_logging()
    handler = next(handler for handler in root.handlers
                   if handler.get_name() == "mizan-file")
    try:
        handler.flush()
        contents = (log_dir / "mizan.log").read_text(encoding="utf-8")
        assert "Mizan startup version=0.2.30 build_id=20261004T113000Z" in contents
    finally:
        root.removeHandler(handler)
        handler.close()
