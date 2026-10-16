import json
import os
import shutil
import subprocess
import sys
import sysconfig
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
MODULE = ROOT / "scripts" / "MizanBuildTools.psm1"

pytestmark = pytest.mark.skipif(
    sys.platform != "win32" or shutil.which("pwsh") is None,
    reason="The build tools need Windows PowerShell 7")


def run_tools(script, **values):
    environment = os.environ.copy()
    environment.update({f"MIZAN_TEST_{key.upper()}": str(value) for key, value in values.items()})
    environment["MIZAN_TEST_MODULE"] = str(MODULE)
    return subprocess.run([
        "pwsh", "-NoProfile", "-NonInteractive", "-Command",
        "$ErrorActionPreference = 'Stop'; Import-Module $env:MIZAN_TEST_MODULE -Force; " + script,
    ], cwd=ROOT, env=environment, capture_output=True, text=True, timeout=60)


def output(script, **values):
    result = run_tools(script, **values)
    assert result.returncode == 0, result.stderr
    return result.stdout.strip()


def write_file(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"")
    return path


def test_nuget_locals_output_uses_the_configured_global_packages_folder():
    assert output(
        "ConvertFrom-NuGetLocalsOutput -Lines @('info : ignored', 'global-packages: Q:\\.tools\\.nuget\\packages\\')"
    ) == "Q:\\.tools\\.nuget\\packages"
    result = run_tools("ConvertFrom-NuGetLocalsOutput -Lines @('error: no config')")
    assert result.returncode != 0
    assert "Could not read the NuGet global-packages folder" in result.stderr


def test_trusted_signing_dlib_picks_the_highest_numeric_x64_version(tmp_path):
    package = tmp_path / "microsoft.trusted.signing.client"
    write_file(package / "1.0.9" / "bin" / "x64" / "Azure.CodeSigning.Dlib.dll")
    expected = write_file(package / "1.0.10" / "bin" / "x64" / "Azure.CodeSigning.Dlib.dll")
    write_file(package / "1.0.11" / "bin" / "arm64" / "Azure.CodeSigning.Dlib.dll")
    write_file(package / "2.0.0-preview" / "bin" / "x64" / "Azure.CodeSigning.Dlib.dll")

    assert output("Find-TrustedSigningDlib -PackagesRoot $env:MIZAN_TEST_ROOT", root=tmp_path) == str(expected)
    assert output("Find-TrustedSigningDlib -PackagesRoot $env:MIZAN_TEST_ROOT", root=tmp_path / "empty") == ""


def test_trusted_signing_dlib_comes_from_the_restore_assets(tmp_path):
    packages = tmp_path / "custom packages"
    expected = write_file(
        packages / "microsoft.trusted.signing.client" / "1.0.95" / "bin" / "x64" / "Azure.CodeSigning.Dlib.dll")
    assets = tmp_path / "project.assets.json"
    assets.write_text(json.dumps({
        "libraries": {
            "Microsoft.Trusted.Signing.Client/1.0.95": {"path": "microsoft.trusted.signing.client/1.0.95"},
            "Other.Package/1.0.0": {"path": "other.package/1.0.0"},
        },
        "packageFolders": {str(packages) + "\\": {}},
    }), encoding="utf-8")

    assert output(
        "Find-TrustedSigningDlibFromAssets -AssetsPath $env:MIZAN_TEST_ASSETS", assets=assets
    ) == str(expected)


def test_explicit_dlib_path_is_validated_before_discovery(tmp_path):
    dlib = write_file(tmp_path / "Azure.CodeSigning.Dlib.dll")
    script = ("Resolve-TrustedSigningDlib -DlibPath $env:MIZAN_TEST_DLIB "
              "-WorkDirectory $env:MIZAN_TEST_WORK -RepositoryRoot $env:MIZAN_TEST_WORK")
    assert output(script, dlib=dlib, work=tmp_path) == str(dlib)

    result = run_tools(script, dlib=tmp_path / "missing.dll", work=tmp_path)
    assert result.returncode != 0
    assert "The -DlibPath file was not found" in result.stderr


@pytest.mark.parametrize("exec_path, matches", [
    ("", True),
    ("C:\\Program Files\\Git\\mingw64\\libexec\\git-core", True),
    ("C:\\Program Files\\Git2\\mingw64\\libexec\\git-core", False),
    ("C:\\Users\\me\\AppData\\Local\\copilot\\git\\libexec\\git-core", False),
])
def test_git_exec_path_must_belong_to_the_git_on_path(exec_path, matches):
    assert output(
        "Test-GitExecPathMatches -GitPath 'C:\\Program Files\\Git\\cmd\\git.exe' -ExecPath $env:MIZAN_TEST_EXEC",
        exec=exec_path,
    ) == str(matches)


def test_windows_sdk_tool_prefers_newest_version_then_tool_architecture(tmp_path):
    write_file(tmp_path / "10.0.9.0" / "x64" / "MakeAppx.exe")
    newest = write_file(tmp_path / "10.0.10.0" / "arm64" / "MakeAppx.exe")
    write_file(tmp_path / "wdf" / "x64" / "MakeAppx.exe")
    script = "Find-WindowsSdkTool MakeAppx.exe -ToolArchitectures {} -SdkRoots $env:MIZAN_TEST_ROOT"

    assert output(script.format("arm64, x64"), root=tmp_path) == str(newest)
    assert output(script.format("x64"), root=tmp_path) == str(tmp_path / "10.0.9.0" / "x64" / "MakeAppx.exe")
    result = run_tools(script.format("x64").replace("MakeAppx", "SignTool"), root=tmp_path)
    assert result.returncode != 0
    assert "SignTool.exe (x64) was not found" in result.stderr


def test_msix_output_path_matches_between_build_and_signing():
    script = "Get-MsixOutputPath -ArtifactsDirectory 'C:\\out' -Version 1.2.3 -Architecture X64 -BuildId $env:MIZAN_TEST_ID"
    assert output(script, id="") == "C:\\out\\Mizan_1.2.3_x64.msix"
    assert output(script, id="20260101T000000Z") == "C:\\out\\Mizan_1.2.3_20260101T000000Z_x64.msix"


@pytest.mark.skipif(sys.version_info[:2] != (3, 12), reason="Needs Python 3.12")
def test_python_discovery_checks_version_and_platform():
    architecture = {"win-arm64": "arm64", "win-amd64": "x64"}.get(sysconfig.get_platform())
    if architecture is None:
        pytest.skip("Unsupported Python platform")
    other = "x64" if architecture == "arm64" else "arm64"
    script = "Find-Python312 -Architecture {} -Candidates @('C:\\missing\\python.exe', $env:MIZAN_TEST_PYTHON)"

    assert output(script.format(architecture), python=sys.executable) == sys.executable
    result = run_tools(script.format(other), python=sys.executable)
    assert result.returncode != 0
    assert f"Python 3.12 for {other}" in result.stderr
