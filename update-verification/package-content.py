import argparse
import hashlib
import json
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path


def digest(stream):
    value = hashlib.sha256()
    with stream:
        while chunk := stream.read(1024 * 1024):
            value.update(chunk)
    return value.hexdigest()


def package_files(path):
    with zipfile.ZipFile(path) as package:
        return {
            entry.filename.replace("\\", "/"): digest(package.open(entry))
            for entry in package.infolist() if not entry.is_dir()
        }


def backend(files):
    metadata = {"AppxManifest.xml", "AppxBlockMap.xml", "AppxSignature.p7x", "[Content_Types].xml"}
    return {
        name: value for name, value in files.items()
        if not name.startswith(("ui/", "AppxMetadata/"))
        and name not in metadata
        and not name.endswith("/mizan/build_info.json")
    }


def appx_contract(package):
    manifest = ET.fromstring(package.read("AppxManifest.xml"))
    identity = manifest.find("{http://schemas.microsoft.com/appx/manifest/foundation/windows10}Identity")
    if identity is None:
        raise RuntimeError("The package has no Windows app identity")
    version = identity.get("Version", "").split(".")
    if len(version) != 4 or any(not part.isascii() or not part.isdecimal() or int(part) > 65535 for part in version):
        raise RuntimeError("The package has an invalid Windows app version")
    associations = {
        node.text.strip().lower()
        for extension in manifest.iter()
        if extension.tag.rsplit("}", 1)[-1] == "Extension" and extension.get("Category") == "windows.fileTypeAssociation"
        for node in extension.iter()
        if node.tag.rsplit("}", 1)[-1] == "FileType" and node.text
    }
    capabilities = {
        (node.tag.rsplit("}", 1)[-1], node.get("Name"))
        for container in manifest
        if container.tag.rsplit("}", 1)[-1] == "Capabilities"
        for node in container
    }
    return identity.attrib, tuple(int(part) for part in version), associations, capabilities


parser = argparse.ArgumentParser()
parser.add_argument("before", type=Path)
parser.add_argument("after", type=Path)
parser.add_argument("output", type=Path)
parser.add_argument("--installed-ui", type=Path)
parser.add_argument("--expected-backend-change", action="append", default=[])
args = parser.parse_args()
old, new = package_files(args.before), package_files(args.after)
old_backend, new_backend = backend(old), backend(new)
changed = sorted(name for name in old_backend.keys() | new_backend.keys() if old_backend.get(name) != new_backend.get(name))
expected = sorted(set(args.expected_backend_change))
unexpected = sorted(set(changed) - set(expected))
missing = sorted(set(expected) - set(changed))
report = {
    "backend_files": len(new_backend), "changed_backend": changed,
    "expected_backend_changes": expected, "unexpected_backend_changes": unexpected,
    "missing_backend_changes": missing, "ui_files": sum(name.startswith("ui/") for name in new),
    "backend_change_hashes": {
        name: {"before": old_backend.get(name), "after": new_backend.get(name)} for name in changed
    },
}
for name in ("AcousticKit.glb", "ElectronicKit.glb"):
    key = "ui/dist/models/" + name
    if key not in new or old.get(key) != new[key]:
        raise RuntimeError("The preserved drum asset changed or is missing: " + name)
manifest_name = "ui/dist/models/KeyboardInstruments.json"
expected_variants = {
    "stage_piano_88": (21, 108, 88, 52, 36),
}
expected_models = {"ui/dist/models/" + name for name in ("AcousticKit.glb", "ElectronicKit.glb", "StagePiano88.glb")}
actual_models = {name for name in new if name.startswith("ui/") and name.lower().endswith(".glb")}
if actual_models != expected_models:
    raise RuntimeError("The package must contain only the stage piano and preserved drum models: " + str(sorted(actual_models)))
with zipfile.ZipFile(args.after) as package:
    new_identity, new_version, new_associations, new_capabilities = appx_contract(package)
    manifest = json.loads(package.read(manifest_name))
    build_info = json.loads(package.read("Python/Lib/site-packages/mizan/build_info.json"))
with zipfile.ZipFile(args.before) as package:
    old_identity, old_version, old_associations, old_capabilities = appx_contract(package)
for field in ("Name", "Publisher", "ProcessorArchitecture", "ResourceId"):
    if old_identity.get(field) != new_identity.get(field):
        raise RuntimeError("The update changed the existing app identity: " + field)
if new_version <= old_version:
    raise RuntimeError("The signed update must have a newer Windows app version")
if new_capabilities != old_capabilities:
    raise RuntimeError("The update changed Windows app permissions")
if new_associations != old_associations | {".mid", ".midi"}:
    raise RuntimeError("The update must preserve existing file types and add only .mid and .midi")
report["app_identity"] = new_identity
report["file_associations"] = sorted(new_associations)
report["capabilities"] = sorted(new_capabilities)
if manifest["defaultVariant"] != "stage_piano_88" or set(manifest["variants"]) != set(expected_variants):
    raise RuntimeError("The packaged piano manifest has the wrong default or variant count")
if manifest["runtimeLooks"] != ["Realistic", "ClayStudyModel", "NeonRhythm", "TechnicalBlueprint"]:
    raise RuntimeError("The packaged stage piano must preserve all four looks")
for variant, info in manifest["variants"].items():
    if tuple(info.get(key) for key in ("low", "high", "keys", "whiteKeys", "blackKeys")) != expected_variants[variant]:
        raise RuntimeError("The packaged piano key layout is incorrect: " + variant)
    if new.get("ui/dist/models/" + info["file"]) != info["sha256"]:
        raise RuntimeError("Packaged piano GLB does not match its manifest: " + variant)
report["piano_variants"] = list(manifest["variants"])
report["build_info"] = build_info
if args.installed_ui:
    installed = {
        "ui/dist/" + path.relative_to(args.installed_ui).as_posix(): digest(path.open("rb"))
        for path in args.installed_ui.rglob("*") if path.is_file()
    }
    bundled = {name: value for name, value in new.items() if name.startswith("ui/")}
    report["changed_installed_ui"] = sorted(name for name in installed.keys() | bundled.keys() if installed.get(name) != bundled.get(name))
args.output.write_text(json.dumps(report, indent=2), encoding="utf-8")
if unexpected or missing or report.get("changed_installed_ui"):
    raise RuntimeError("Update preservation or installed bundle verification failed: " + str(report))
print(f"Preserved app identity, permissions, unrelated backend files and both drum GLBs; {len(changed)} exact expected backend changes; only the 88-key stage piano ships, with four looks and .mid/.midi associations")
if args.installed_ui:
    print(f"Every installed UI file matches the signed package: {len(installed)} files")
