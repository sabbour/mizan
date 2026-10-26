import importlib.util
import json
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("credits", ROOT / "scripts" / "credits.py")
credits = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(credits)


def _package(name, version, license_name, license_text, author="Upstream author"):
    return {
        "Name": name,
        "Version": version,
        "License": license_name,
        "LicenseText": license_text,
        "Author": author,
        "URL": f"https://example.test/{name}",
    }


def _generate(monkeypatch, tmp_path, packages):
    monkeypatch.setattr(credits, "OUTPUT_LICENSES", tmp_path)
    monkeypatch.setattr(credits, "run", lambda *_args, **_kwargs: json.dumps(packages))
    monkeypatch.setattr(
        credits,
        "production_python_names",
        lambda: {"flatbuffers", "proxy-tools", "unrelated-package"},
    )
    return credits.python_credits()


def _release_packages(proxy_name="proxy_tools", flatbuffers_text="UNKNOWN", proxy_text=""):
    return [
        _package("flatbuffers", "25.12.19", "Apache Software License", flatbuffers_text),
        _package(proxy_name, "0.1.0", "MIT", proxy_text, author="Metadata author"),
        _package("unrelated-package", "1.2.3", "MIT License", "Unrelated license text.", "Unrelated author"),
        _package("onnxruntime-windowsml", "1.0", "MIT", "Windows ML MIT license"),
    ]


@pytest.mark.parametrize("proxy_name", ["proxy_tools", "proxy-tools"])
@pytest.mark.parametrize("missing_text", ["", "UNKNOWN", " \nunknown \n", None])
def test_python_credits_use_verified_text_and_proxy_attribution(
    monkeypatch, tmp_path, proxy_name, missing_text
):
    generated = _generate(
        monkeypatch, tmp_path,
        _release_packages(
            proxy_name=proxy_name, flatbuffers_text=missing_text, proxy_text=missing_text
        ),
    )
    by_name = {item["name"].replace("_", "-"): item for item in generated}

    flatbuffers = by_name["flatbuffers"]
    assert flatbuffers["license"] == "Apache-2.0"
    assert (tmp_path / "host-flatbuffers.txt").read_text(encoding="utf-8") == (
        (ROOT / "scripts" / "licenses" / "apache-2.0.txt").read_text(encoding="utf-8").rstrip() + "\n"
    )
    assert "No license file was exposed" not in (tmp_path / "host-flatbuffers.txt").read_text(encoding="utf-8")

    proxy = by_name["proxy-tools"]
    assert proxy["license"] == "BSD-2-Clause"
    assert proxy["author"] == (
        "Copyright (c) 2013 Armin Ronacher; Copyright (c) 2014 Jonathan Tushman"
    )
    assert (tmp_path / "host-proxy-tools.txt").read_text(encoding="utf-8") == (
        (ROOT / "scripts" / "licenses" / "proxy-tools.txt").read_text(encoding="utf-8").rstrip() + "\n"
    )

    unrelated = by_name["unrelated-package"]
    assert unrelated["license"] == "MIT"
    assert unrelated["author"] == "Unrelated author"
    assert (tmp_path / "host-unrelated-package.txt").read_text(encoding="utf-8") == "Unrelated license text.\n"


def test_python_credits_preserve_real_flatbuffers_license_text(monkeypatch, tmp_path):
    packages = _release_packages(flatbuffers_text="Real installed Apache license text.")
    generated = _generate(monkeypatch, tmp_path, packages)
    flatbuffers = next(item for item in generated if item["name"] == "flatbuffers")

    assert flatbuffers["license"] == "Apache-2.0"
    assert (tmp_path / "host-flatbuffers.txt").read_text(encoding="utf-8") == (
        "Real installed Apache license text.\n"
    )


def test_python_credits_override_nonempty_mit_proxy_metadata(monkeypatch, tmp_path):
    packages = _release_packages(proxy_text="Misleading MIT license metadata.")
    generated = _generate(monkeypatch, tmp_path, packages)
    proxy = next(item for item in generated if item["name"] == "proxy_tools")

    assert proxy["license"] == "BSD-2-Clause"
    assert proxy["author"] == (
        "Copyright (c) 2013 Armin Ronacher; Copyright (c) 2014 Jonathan Tushman"
    )
    license_text = (tmp_path / "host-proxy-tools.txt").read_text(encoding="utf-8")
    assert license_text == (
        (ROOT / "scripts" / "licenses" / "proxy-tools.txt").read_text(encoding="utf-8").rstrip() + "\n"
    )
    assert "Misleading MIT license metadata." not in license_text


@pytest.mark.parametrize(
    ("name", "version"),
    [("flatbuffers", "25.12.20"), ("proxy_tools", "0.1.1")],
)
def test_python_credits_reject_unverified_package_versions(monkeypatch, tmp_path, name, version):
    packages = _release_packages()
    package = next(item for item in packages if item["Name"] == name)
    package["Version"] = version

    with pytest.raises(RuntimeError, match="applies only to version"):
        _generate(monkeypatch, tmp_path, packages)


def test_checked_in_release_credits_use_correct_licenses_and_attribution():
    apache = (ROOT / "scripts" / "licenses" / "apache-2.0.txt").read_text(encoding="utf-8")
    proxy = (ROOT / "scripts" / "licenses" / "proxy-tools.txt").read_text(encoding="utf-8")
    assert (ROOT / "licenses" / "host-flatbuffers.txt").read_text(encoding="utf-8") == apache.rstrip() + "\n"
    assert (ROOT / "licenses" / "host-proxy-tools.txt").read_text(encoding="utf-8") == proxy.rstrip() + "\n"
    assert "Copyright (c) 2013 Armin Ronacher" in proxy
    assert "Copyright (c) 2014 Jonathan Tushman" in proxy
    assert proxy.endswith("OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.")

    ui_credits = json.loads((ROOT / "ui" / "src" / "credits.json").read_text(encoding="utf-8"))
    proxy_record = next(item for item in ui_credits if item["name"] == "proxy_tools")
    assert proxy_record["license"] == "BSD-2-Clause"
    assert proxy_record["author"] == (
        "Copyright (c) 2013 Armin Ronacher; Copyright (c) 2014 Jonathan Tushman"
    )
    assert "| proxy_tools | 0.1.0 | [BSD-2-Clause](licenses/host-proxy-tools.txt) | " \
        "Copyright (c) 2013 Armin Ronacher; Copyright (c) 2014 Jonathan Tushman | " \
        "http://github.com/jtushman/proxy_tools |" in (
            ROOT / "THIRD_PARTY_NOTICES.md"
        ).read_text(encoding="utf-8")
