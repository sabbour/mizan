import json
import hashlib
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path


root = Path(__file__).parent
with tempfile.TemporaryDirectory(prefix="mizan-update-gate-", dir=root) as directory:
    temp = Path(directory)
    old, new = temp / "old.msix", temp / "new.msix"
    output = temp / "report.json"
    old_manifest = b"""<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
      xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10">
      <Identity Name="Mizan" Publisher="CN=Test" ProcessorArchitecture="arm64" Version="0.2.30.15" />
      <Applications><Application Id="App" Executable="Mizan.Shell.exe"><Extensions /></Application></Applications>
      <Capabilities><Capability Name="internetClient" /></Capabilities>
    </Package>"""
    associations = b"""<Extensions><uap:Extension Category="windows.fileTypeAssociation">
      <uap:FileTypeAssociation Name="mizan-midi"><uap:SupportedFileTypes>
        <uap:FileType>.mid</uap:FileType><uap:FileType>.midi</uap:FileType>
      </uap:SupportedFileTypes></uap:FileTypeAssociation>
    </uap:Extension></Extensions>"""
    new_manifest = old_manifest.replace(b'Version="0.2.30.15"', b'Version="0.2.30.16"').replace(b"<Extensions />", associations)
    files = {
        "Mizan.Shell.dll": b"preserved shell",
        "Python/Lib/site-packages/mizan/engine.py": b"preserved backend",
        "Python/Lib/site-packages/mizan/build_info.json": b'{"build":"old"}',
        "ui/dist/index.html": b'<div id="root"></div>',
        "ui/dist/models/AcousticKit.glb": b"preserved acoustic",
        "ui/dist/models/ElectronicKit.glb": b"preserved electronic",
        "AppxManifest.xml": old_manifest,
        "AppxSignature.p7x": b"old signature",
    }
    updated = dict(files)
    updated["AppxManifest.xml"] = new_manifest
    updated["AppxSignature.p7x"] = b"new signature"
    updated["Python/Lib/site-packages/mizan/build_info.json"] = b'{"build":"new"}'
    content = b"stage piano"
    updated["ui/dist/models/StagePiano88.glb"] = content
    variants = {
        "stage_piano_88": {
            "file": "StagePiano88.glb", "sha256": hashlib.sha256(content).hexdigest(),
            "low": 21, "high": 108, "keys": 88, "whiteKeys": 52, "blackKeys": 36,
        },
    }
    updated["ui/dist/models/KeyboardInstruments.json"] = json.dumps({
        "defaultVariant": "stage_piano_88", "variants": variants,
        "runtimeLooks": ["Realistic", "ClayStudyModel", "NeonRhythm", "TechnicalBlueprint"],
    }).encode()

    def archive(path, contents):
        with zipfile.ZipFile(path, "w") as package:
            for name, content in contents.items():
                package.writestr(name, content)

    def check(contents, expected, expected_changes=()):
        archive(new, contents)
        result = subprocess.run(
            [sys.executable, str(root / "package-content.py"), str(old), str(new), str(output),
             *(argument for name in expected_changes for argument in ("--expected-backend-change", name))],
            capture_output=True, text=True,
        )
        if (result.returncode == 0) != expected:
            raise AssertionError(result.stdout + result.stderr)

    archive(old, files)
    check(updated, True)
    for before, after in (
        (b'Name="Mizan"', b'Name="AnotherApp"'),
        (b'Publisher="CN=Test"', b'Publisher="CN=Other"'),
        (b'ProcessorArchitecture="arm64"', b'ProcessorArchitecture="x64"'),
        (b'Version="0.2.30.16"', b'Version="0.2.30.15"'),
        (b'Version="0.2.30.16"', b'Version="0.2.30.65536"'),
        (b"<Capabilities>", b'<Capabilities><Capability Name="location" />'),
        (b"<uap:FileType>.midi</uap:FileType>", b""),
        (b"<uap:SupportedFileTypes>", b"<uap:SupportedFileTypes><uap:FileType>.mp3</uap:FileType>"),
    ):
        check({**updated, "AppxManifest.xml": new_manifest.replace(before, after)}, False)
    for key in ("Mizan.Shell.dll", "ui/dist/models/AcousticKit.glb", "ui/dist/models/StagePiano88.glb"):
        check({**updated, key: b"unexpected change"}, False)
    check({**updated, "Mizan.Shell.dll": b"expected MIDI file activation"}, True, ("Mizan.Shell.dll",))
    check({**updated, "Mizan.Shell.dll": b"expected MIDI file activation",
           "Python/Lib/site-packages/mizan/engine.py": b"unrelated change"}, False, ("Mizan.Shell.dll",))
    check(updated, False, ("Mizan.Shell.dll",))
    missing = {name: content for name, content in updated.items() if name != "ui/dist/models/StagePiano88.glb"}
    check(missing, False)
    wrong = json.loads(updated["ui/dist/models/KeyboardInstruments.json"])
    wrong["variants"]["stage_piano_88"]["whiteKeys"] = 51
    check({**updated, "ui/dist/models/KeyboardInstruments.json": json.dumps(wrong).encode()}, False)
    wrong = json.loads(updated["ui/dist/models/KeyboardInstruments.json"])
    wrong["defaultVariant"] = "digital_keyboard_88"
    check({**updated, "ui/dist/models/KeyboardInstruments.json": json.dumps(wrong).encode()}, False)
    wrong = json.loads(updated["ui/dist/models/KeyboardInstruments.json"])
    wrong["variants"]["grand_piano_88"] = variants["stage_piano_88"]
    check({**updated, "ui/dist/models/KeyboardInstruments.json": json.dumps(wrong).encode()}, False)
    for filename in ("KeyboardDigital61.glb", "KeyboardDigital76.glb", "KeyboardDigital88.glb", "UprightPiano88.glb", "GrandPiano88.glb"):
        check({**updated, "ui/dist/models/" + filename: b"retired model"}, False)
    installed = temp / "installed-ui"
    for name, content in updated.items():
        if not name.startswith("ui/"):
            continue
        path = installed / name.removeprefix("ui/dist/")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
    archive(new, updated)
    result = subprocess.run(
        [sys.executable, str(root / "package-content.py"), str(old), str(new), str(output), "--installed-ui", str(installed)],
        capture_output=True, text=True,
    )
    if result.returncode:
        raise AssertionError(result.stdout + result.stderr)
    assert json.loads(output.read_text())["changed_installed_ui"] == []
    (installed / "index.html").write_text("wrong installed build")
    result = subprocess.run(
        [sys.executable, str(root / "package-content.py"), str(old), str(new), str(output), "--installed-ui", str(installed)],
        capture_output=True, text=True,
    )
    assert result.returncode != 0
print("Final update gate accepts only a newer matching app identity, unchanged permissions, MIDI associations, exact backend changes, preserved drum assets, the matching stage piano, and exact installed UI")
