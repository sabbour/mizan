import ctypes
import os
import sysconfig
from pathlib import Path


def _configure_pythonnet() -> None:
    if sysconfig.get_platform() != "win-arm64":
        return
    os.environ.setdefault("PYTHONNET_RUNTIME", "coreclr")
    os.environ.setdefault(
        "PYTHONNET_CORECLR_RUNTIME_CONFIG",
        str(Path(__file__).with_name("mizan.runtimeconfig.json")),
    )


_configure_pythonnet()

import webview

from .api import Api
from .artifacts import ArtifactServer
from .jobs import JobRunner, JobStore
from .logging_setup import configure_file_logging

APP_USER_MODEL_ID = "Mizan.App"


def _set_app_user_model_id() -> None:
    setter = ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID
    setter.argtypes = [ctypes.c_wchar_p]
    setter.restype = ctypes.c_long
    result = setter(APP_USER_MODEL_ID)
    if result:
        raise OSError(result, "Could not set the Mizan AppUserModelID.")


def main() -> None:
    configure_file_logging()
    _set_app_user_model_id()
    url = os.environ.get("MIZAN_DEV_URL")
    if not url:
        index = Path(__file__).resolve().parents[2] / "ui" / "dist" / "index.html"
        if not index.is_file():
            raise FileNotFoundError("Build the UI first or set MIZAN_DEV_URL to the Vite server.")
        url = str(index)
    runner = JobRunner(JobStore())
    artifacts = ArtifactServer()
    icon = Path(__file__).with_name("assets") / "mizan.ico"
    try:
        webview.create_window("Mizan", url=url, js_api=Api(runner, artifacts),
                              width=1440, height=900, min_size=(1024, 640))
        webview.start(gui="edgechromium", icon=str(icon))
    finally:
        artifacts.close()
        runner.close()
