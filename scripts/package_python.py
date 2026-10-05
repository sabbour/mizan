"""Build a relocatable Python runtime from the active Mizan ARM64 environment."""

from __future__ import annotations

import json
import shutil
import sys
import tomllib
from importlib import metadata
from pathlib import Path
from urllib.parse import unquote, urlsplit

from packaging.markers import default_environment
from packaging.requirements import Requirement
from packaging.utils import canonicalize_name, parse_wheel_filename

ROOT = Path(__file__).resolve().parents[1]


def project_config() -> dict:
    return tomllib.loads((ROOT / "host" / "pyproject.toml").read_text(encoding="utf-8"))


def pinned_source(requirement: Requirement, distribution: metadata.Distribution) -> None:
    if requirement.url and requirement.url.startswith("git+"):
        origin = json.loads(distribution.read_text("direct_url.json") or "{}")
        revision = requirement.url.rsplit("@", 1)[-1]
        if origin.get("vcs_info", {}).get("commit_id") != revision:
            raise RuntimeError(
                f"Production dependency {requirement.name} must be installed from pinned "
                f"Git commit {revision}.")


def production_distributions() -> list[metadata.Distribution]:
    project = project_config()["project"]
    installed = {
        canonicalize_name(dist.metadata["Name"]): dist
        for dist in metadata.distributions()
        if dist.metadata.get("Name")
    }
    todo = [Requirement(raw) for raw in project["dependencies"]]
    selected: dict[str, metadata.Distribution] = {}
    extras: dict[str, set[str]] = {}
    while todo:
        requirement = todo.pop()
        name = canonicalize_name(requirement.name)
        requested = set(requirement.extras)
        if name in extras and requested <= extras[name]:
            continue
        extras.setdefault(name, set()).update(requested)
        distribution = installed.get(name)
        if distribution is None:
            raise RuntimeError(f"Production dependency is not installed: {requirement.name}")
        if requirement.specifier and distribution.version not in requirement.specifier:
            raise RuntimeError(
                f"Production dependency {requirement.name} must match {requirement.specifier}; "
                f"found {distribution.version}")
        if requirement.url and urlsplit(requirement.url).path.endswith(".whl"):
            wheel = unquote(Path(urlsplit(requirement.url).path).name)
            wheel_name, wheel_version, _, _ = parse_wheel_filename(wheel)
            if wheel_name != name or str(wheel_version) != distribution.version:
                raise RuntimeError(f"Production dependency {requirement.name} does not match pinned wheel {wheel}.")
        pinned_source(requirement, distribution)
        selected[name] = distribution
        active_extras = extras[name] or {""}
        for raw in distribution.requires or []:
            child = Requirement(raw)
            if child.marker and not any(
                child.marker.evaluate(default_environment() | {"extra": extra})
                for extra in active_extras
            ):
                continue
            todo.append(child)
    return list(selected.values())


def copy_distribution(distribution: metadata.Distribution, destination: Path) -> None:
    for relative in distribution.files or []:
        source = Path(distribution.locate_file(relative))
        lowered = {part.lower() for part in source.parts}
        if (
            not source.is_file()
            or "__pycache__" in source.parts
            or lowered.intersection({"test", "tests"})
            or source.suffix in {".pyc", ".onnx"}
        ):
            continue
        target = destination / Path(relative)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)


def copy_muscriptor_source(destination: Path) -> None:
    configuration = project_config()["tool"]["mizan"]
    requirement = Requirement(configuration["muscriptor-inference-source"])
    try:
        distribution = metadata.distribution(requirement.name)
    except metadata.PackageNotFoundError as exc:
        raise RuntimeError(
            "Pinned MuScriptor inference source is missing from the build environment. "
            "Install the configured Git revision with --no-deps before packaging; "
            "upstream's server/beat-this extras require unavailable ARM64 torchaudio.") from exc
    if distribution.version != configuration["muscriptor-version"]:
        raise RuntimeError(f"MuScriptor source must be version {configuration['muscriptor-version']}.")
    pinned_source(requirement, distribution)
    files = distribution.files or []
    source_files = [file for file in files if file.parts[0] == "muscriptor"
                    and "__pycache__" not in file.parts and file.suffix != ".pyc"]
    license_files = [file for file in files if file.name == "LICENSE"
                     and "licenses" in file.parts]
    if not source_files or not license_files:
        raise RuntimeError("Pinned MuScriptor source or MIT license is missing.")
    for relative in source_files:
        source = Path(distribution.locate_file(relative))
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
    shutil.copy2(distribution.locate_file(license_files[0]),
                 destination / "muscriptor" / "LICENSE")


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("Usage: package_python.py <destination>")
    destination = Path(sys.argv[1]).resolve()
    if destination.exists():
        shutil.rmtree(destination)
    destination.mkdir(parents=True)

    base = Path(sys.base_prefix)
    if "arm64" not in sysconfig_platform():
        raise RuntimeError("The MSIX Python runtime must be built with ARM64 Python.")
    for name in ("python.exe", "pythonw.exe", "python3.dll", "python312.dll",
                 "vcruntime140.dll", "vcruntime140_1.dll", "LICENSE.txt"):
        source = base / name
        if source.is_file():
            shutil.copy2(source, destination / name)

    shutil.copytree(base / "DLLs", destination / "DLLs")
    ignored = shutil.ignore_patterns("site-packages", "test", "tests", "tkinter", "idlelib",
                                     "ensurepip", "__pycache__", "*.pyc")
    shutil.copytree(base / "Lib", destination / "Lib", ignore=ignored)
    site_packages = destination / "Lib" / "site-packages"
    site_packages.mkdir(parents=True)
    for distribution in production_distributions():
        copy_distribution(distribution, site_packages)
    copy_muscriptor_source(site_packages)
    shutil.copytree(ROOT / "host" / "mizan", site_packages / "mizan",
                    ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))


def sysconfig_platform() -> str:
    import sysconfig
    return sysconfig.get_platform()


if __name__ == "__main__":
    main()
