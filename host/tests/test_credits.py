import hashlib
import json
from pathlib import Path

import pytest

from scripts import credits

ROOT = Path(__file__).resolve().parents[2]
VENDOR_SHA256 = {
    "dotnet-runtime-10.0.15-LICENSE.TXT": "d7a68596ab69b06f51ca278a6545148e4269a9381c26d597c13df5d88e08cf5b",
    "dotnet-runtime-10.0.15-THIRD-PARTY-NOTICES.TXT": "6d15e10a101c6bfff2ab4429ed061bf76c456fc4b23ad6b03e0d0f8377148a21",
    "webview2-sdk-1.0.3179.45-LICENSE.txt": "0af8f1b807512aae39c2ac1aa4d0cae65cabecb6fd554b8439a5162a0d6eca55",
    "webview2-sdk-1.0.3179.45-NOTICE.txt": "106423785c5b7eba0a8e61d1837f2132e9c828e20ad530f565d981c1df60dd90",
    "windows-app-sdk-1.8.260921001-license.txt": "5b11e6347756e40fe0274bc08c97f89201b94f0d50181a09a00f1f4740840501",
    "windows-app-sdk-1.8.260921001-NOTICE.txt": "e25393c0d340a1821827b093fa4dbbfcccd8feb7bf769e7fa773e3955cd5314b",
    "windows-app-sdk-dwrite-1.8.25122902-license.txt": "f9ed00147604bdc48c7e62d127d73245781ce53903cef9c3863f8a7ef8120cc2",
    "windows-app-sdk-foundation-1.8.260803002-license.txt": "5b11e6347756e40fe0274bc08c97f89201b94f0d50181a09a00f1f4740840501",
    "windows-app-sdk-ml-1.8.2223-license.txt": "656aab74c15aa9f9964bcdcc993eb2755cbdb4822d5e0e3bc61d2e281897f758",
    "windows-app-sdk-ml-1.8.2223-ThirdPartyNotices.txt": "e00f828e0a33de591a355ae6606d2625f5758da7d2c844db7821c9dd3e3647b6",
    "windows-app-sdk-widgets-1.8.251231004-license.txt": "f9ed00147604bdc48c7e62d127d73245781ce53903cef9c3863f8a7ef8120cc2",
    "windows-app-sdk-winui-1.8.260803003-license.txt": "5b11e6347756e40fe0274bc08c97f89201b94f0d50181a09a00f1f4740840501",
    "windows-app-sdk-winui-1.8.260803003-NOTICE.txt": "e25393c0d340a1821827b093fa4dbbfcccd8feb7bf769e7fa773e3955cd5314b",
}


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


def test_python_credits_include_system_packages_in_production_graph(monkeypatch, tmp_path):
    packages = [
        _package("setuptools", "80.9.0", "MIT License", "Setuptools MIT license"),
        _package("onnxruntime-windowsml", "1.0", "MIT", "Windows ML MIT license"),
        _package("pip", "25.1", "MIT", "Pip MIT license"),
        _package("pytest", "8.4.0", "MIT", "Pytest MIT license"),
    ]
    wanted = {"setuptools", "onnxruntime-windowsml"}

    def piplicenses(*args, **_kwargs):
        included = packages if "--with-system" in args else packages[1:]
        return json.dumps(included)

    monkeypatch.setattr(credits, "OUTPUT_LICENSES", tmp_path)
    monkeypatch.setattr(credits, "run", piplicenses)
    monkeypatch.setattr(credits, "production_python_names", lambda: wanted)

    generated = credits.python_credits()

    assert {credits.canonicalize_name(item["name"]) for item in generated} == wanted
    assert (tmp_path / "host-setuptools.txt").read_text(encoding="utf-8") == "Setuptools MIT license\n"
    assert {path.name for path in tmp_path.iterdir()} == {
        "host-setuptools.txt",
        "host-onnxruntime-windowsml.txt",
    }


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


def test_checked_in_vendor_credits_have_exact_versions_and_labels():
    release_credits = json.loads(
        (ROOT / "ui" / "src" / "credits.json").read_text(encoding="utf-8")
    )
    expected = {
        ".NET Runtime": ("10.0.15", "MIT"),
        "Windows App SDK Runtime": ("1.8.260921001", "Microsoft Software License Terms"),
        "Windows App SDK Foundation": (
            "1.8.260803002",
            "Microsoft Software License Terms",
        ),
        "Windows App SDK WinUI": ("1.8.260803003", "Microsoft Software License Terms"),
        "Windows App SDK DWrite": ("1.8.25122902", "Microsoft Software License Terms"),
        "Windows App SDK Widgets": (
            "1.8.251231004",
            "Microsoft Software License Terms",
        ),
        "Windows ML Runtime": ("1.8.2223", "Microsoft Software License Terms"),
        "Bundled WebView2 SDK": ("1.0.3179.45", "BSD-3-Clause"),
        "Microsoft Edge WebView2 Runtime": (
            "System installed",
            "LicenseRef-Microsoft-WebView2-Runtime",
        ),
    }

    by_name = {item["name"]: item for item in release_credits}
    assert {
        name: (by_name[name]["version"], by_name[name]["license"]) for name in expected
    } == expected

    python_wheel = by_name["onnxruntime-windowsml"]
    assert python_wheel["version"] == "1.27.1.202607110137"
    assert python_wheel["license"] == "MIT"
    assert by_name["wasdk-Microsoft.Windows.AI.MachineLearning"]["version"] == (
        "1.8.260209005"
    )


def test_checked_in_vendor_materials_are_copied_byte_for_byte_and_linked():
    vendor = ROOT / "scripts" / "licenses" / "vendor"
    notices = (ROOT / "THIRD_PARTY_NOTICES.md").read_text(encoding="utf-8")
    expected_names = set(VENDOR_SHA256)

    assert {path.name for path in vendor.iterdir()} == expected_names
    for name in expected_names:
        data = (vendor / name).read_bytes()
        assert hashlib.sha256(data).hexdigest() == VENDOR_SHA256[name]
        assert (ROOT / "licenses" / name).read_bytes() == data
        assert f"](licenses/{name})" in notices


def test_checked_in_credits_keep_all_production_python_packages():
    release_credits = json.loads(
        (ROOT / "ui" / "src" / "credits.json").read_text(encoding="utf-8")
    )
    python_credits = [
        item
        for item in release_credits
        if item["group"] == "Host/engine libraries" or item["name"] == "yt-dlp"
    ]

    assert len(python_credits) == 144
    assert len({item["name"] for item in python_credits}) == 144


def test_msix_recursively_stages_generated_license_directory():
    build_script = (ROOT / "scripts" / "Build-Msix.ps1").read_text(encoding="utf-8")

    assert (
        'Copy-Item (Join-Path $root "licenses") (Join-Path $staging "licenses") -Recurse'
        in build_script
    )
