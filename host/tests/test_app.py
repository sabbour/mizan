from urllib.request import Request, urlopen
from unittest.mock import Mock

from mizan import app
from mizan.artifacts import ArtifactServer


def test_arm64_configures_pythonnet_for_windows_desktop(monkeypatch):
    monkeypatch.delenv("PYTHONNET_RUNTIME", raising=False)
    monkeypatch.delenv("PYTHONNET_CORECLR_RUNTIME_CONFIG", raising=False)
    monkeypatch.setattr(app.sysconfig, "get_platform", lambda: "win-arm64")

    app._configure_pythonnet()

    assert app.os.environ["PYTHONNET_RUNTIME"] == "coreclr"
    config = app.Path(app.os.environ["PYTHONNET_CORECLR_RUNTIME_CONFIG"])
    assert config.name == "mizan.runtimeconfig.json"
    assert config.is_file()


def test_artifact_server_supports_browser_fetch_and_ranges(tmp_path):
    artifact = tmp_path / "score.mid"
    artifact.write_bytes(b"0123456789")
    server = ArtifactServer()
    try:
        url = server.url(artifact)
        with urlopen(url) as response:
            assert response.read() == b"0123456789"
            assert response.headers["Access-Control-Allow-Origin"] == "*"
        with urlopen(Request(url, headers={"Range": "bytes=2-5"})) as response:
            assert response.status == 206
            assert response.headers["Content-Range"] == "bytes 2-5/10"
            assert response.read() == b"2345"
    finally:
        server.close()


def test_dev_window_configuration_without_gui(monkeypatch):
    monkeypatch.setenv("MIZAN_DEV_URL", "http://localhost:5173")
    create_window, start, runner, artifacts = Mock(), Mock(), Mock(), Mock()
    monkeypatch.setattr(app.webview, "create_window", create_window)
    monkeypatch.setattr(app.webview, "start", start)
    monkeypatch.setattr(app, "JobRunner", Mock(return_value=runner))
    monkeypatch.setattr(app, "ArtifactServer", Mock(return_value=artifacts))
    set_app_id = Mock()
    monkeypatch.setattr(app, "_set_app_user_model_id", set_app_id)
    monkeypatch.setitem(app.webview.settings, "OPEN_EXTERNAL_LINKS_IN_BROWSER", False)
    app.main()
    assert app.webview.settings["OPEN_EXTERNAL_LINKS_IN_BROWSER"] is True
    args, kwargs = create_window.call_args
    assert args == ("Mizan",)
    assert kwargs["url"] == "http://localhost:5173"
    assert kwargs["width"] == 1440
    assert kwargs["height"] == 900
    assert kwargs["min_size"] == (1024, 640)
    assert isinstance(kwargs["js_api"], app.Api)
    set_app_id.assert_called_once_with()
    start.assert_called_once()
    assert start.call_args.kwargs["gui"] == "edgechromium"
    assert start.call_args.kwargs["icon"].endswith(r"mizan\assets\mizan.ico")
    artifacts.close.assert_called_once()
    runner.close.assert_called_once()


def test_built_ui_path_without_gui(monkeypatch, caplog):
    monkeypatch.delenv("MIZAN_DEV_URL", raising=False)
    expected = app.Path(app.__file__).resolve().parents[2] / "ui" / "dist" / "index.html"
    real_is_file = app.Path.is_file
    monkeypatch.setattr(app.Path, "is_file",
                        lambda path: path == expected or real_is_file(path))
    create_window = Mock()
    monkeypatch.setattr(app.webview, "create_window", create_window)
    monkeypatch.setattr(app.webview, "start", Mock())
    monkeypatch.setattr(app, "JobRunner", Mock())
    monkeypatch.setattr(app, "ArtifactServer", Mock())
    monkeypatch.setattr(app, "_set_app_user_model_id", Mock())
    caplog.set_level("INFO", logger="mizan.logging_setup")
    app.main()
    assert create_window.call_args.kwargs["url"] == str(expected)
    assert "version=development build_id=source" in caplog.text
