r"""Regenerate third-party credits from installed production dependencies.

Run from the repository root:
    host\.venv\Scripts\python.exe scripts\credits.py

Requires `pip-licenses` in the host venv; `npx` supplies license-checker.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tomllib
from importlib import metadata
from pathlib import Path

from packaging.markers import default_environment
from packaging.requirements import Requirement
from packaging.utils import canonicalize_name

ROOT = Path(__file__).resolve().parents[1]
LICENSES = ROOT / "licenses"
OUTPUT_LICENSES = LICENSES
GROUPS = ["App UI libraries", "Host/engine libraries", "Models", "Tools", "Fonts & assets"]
SPDX = {
    "MIT License": "MIT",
    "BSD License": "BSD-3-Clause",
    "3-Clause BSD License": "BSD-3-Clause",
    "Apache Software License": "Apache-2.0",
    "Unlicense": "Unlicense",
    "UNKNOWN": "NOASSERTION",
}
OVERRIDES = {
    "clr-loader": "MIT",
    "pywebview": "BSD-3-Clause",
    "scipy": "BSD-3-Clause",
}
HOLDERS = {
    "cffi": "Copyright Armin Rigo and contributors",
    "flatbuffers": "Copyright Google LLC",
    "lie": "Copyright Calvin Metcalf and contributors",
    "packaging": "Python Packaging Authority and contributors",
    "process-nextick-args": "Copyright Calvin Metcalf and contributors",
    "proxy-tools": "Copyright Jacob Tushman and contributors",
    "typing-extensions": "Python Software Foundation and contributors",
    "yt-dlp": "Public-domain dedication by yt-dlp contributors",
}


def run(*args: str, cwd: Path = ROOT) -> str:
    result = subprocess.run(args, cwd=cwd, check=True, text=True, capture_output=True)
    return result.stdout


def safe(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def holder(text: str, fallback: str) -> str:
    for line in text.splitlines():
        if re.match(r"^\s*(copyright\b|\(c\)|©)", line, re.IGNORECASE) and len(line.strip()) < 240:
            return line.strip()
    return fallback or "Project contributors"


def save_license(name: str, text: str) -> str:
    filename = f"{safe(name)}.txt"
    path = OUTPUT_LICENSES / filename
    path.write_text(text.rstrip() + "\n", encoding="utf-8")
    return (Path("licenses") / filename).as_posix()


def production_python_names() -> set[str]:
    project = tomllib.loads((ROOT / "host" / "pyproject.toml").read_text(encoding="utf-8"))["project"]
    installed = {
        canonicalize_name(dist.metadata["Name"]): dist
        for dist in metadata.distributions()
        if dist.metadata.get("Name")
    }
    todo = [Requirement(raw) for raw in project["dependencies"]]
    extras: dict[str, set[str]] = {}
    while todo:
        requirement = todo.pop()
        name = canonicalize_name(requirement.name)
        requested = set(requirement.extras)
        if name in extras and requested <= extras[name]:
            continue
        extras.setdefault(name, set()).update(requested)
        dist = installed.get(name)
        if not dist:
            raise RuntimeError(f"Production dependency is not installed: {requirement.name}")
        active_extras = extras[name] or {""}
        for raw in dist.requires or []:
            child = Requirement(raw)
            if child.marker and not any(
                child.marker.evaluate(default_environment() | {"extra": extra}) for extra in active_extras
            ):
                continue
            todo.append(child)
    return set(extras) | {"muscriptor"}


def npm_credits() -> list[dict[str, str]]:
    command = "npx.cmd" if os.name == "nt" else "npx"
    raw = json.loads(run(command, "--yes", "license-checker-rseidelsohn", "--production", "--json",
                         cwd=ROOT / "ui"))
    credits = []
    for key, package in sorted(raw.items()):
        name, version = key.rsplit("@", 1)
        if name == "ui":
            continue
        text = Path(package["licenseFile"]).read_text(encoding="utf-8", errors="replace")
        license_id = package["licenses"].strip("()")
        if name == "jszip":
            license_id = "MIT"
        group = "Fonts & assets" if name.startswith("@fontsource") else "App UI libraries"
        note = ""
        if name == "jszip":
            note = "Upstream offers MIT or GPL-3.0-or-later; Mizan uses the MIT option."
        credits.append(
            {
                "name": name,
                "version": version,
                "license": license_id,
                "author": HOLDERS.get(canonicalize_name(name), holder(text, package.get("publisher", ""))),
                "url": package.get("repository", ""),
                "group": group,
                "note": (
                    "Archivo is bundled for UI text; outlined Archivo glyphs are also embedded in the wordmark."
                    if name.startswith("@fontsource") else note
                ),
                "_license": save_license(f"ui-{name}", text),
            }
        )
    return credits


def python_credits() -> list[dict[str, str]]:
    try:
        raw = json.loads(run(str(Path(os.sys.executable)), "-m", "piplicenses", "--format=json",
                             "--with-urls", "--with-license-file"))
    except (subprocess.CalledProcessError, json.JSONDecodeError) as error:
        raise RuntimeError("Install pip-licenses in host\\.venv, then rerun this script.") from error
    wanted = production_python_names()
    windows_mit = next(
        package["LicenseText"] for package in raw if canonicalize_name(package["Name"]) == "onnxruntime-windowsml"
    )
    credits = []
    for package in sorted(raw, key=lambda item: item["Name"].lower()):
        canonical = canonicalize_name(package["Name"])
        if canonical not in wanted:
            continue
        license_id = OVERRIDES.get(canonical, SPDX.get(package["License"], package["License"]))
        text = package.get("LicenseText", "")
        if not text or text == "UNKNOWN":
            if license_id == "MIT" and (canonical.startswith("winrt-") or canonical.startswith("wasdk-")):
                text = windows_mit
            else:
                text = f"No license file was exposed by the installed distribution.\nDeclared license: {license_id}\n"
        group = "Tools" if canonical == "yt-dlp" else "Host/engine libraries"
        credits.append(
            {
                "name": package["Name"],
                "version": package["Version"],
                "license": license_id,
                "author": HOLDERS.get(canonical, holder(text, package.get("Author", ""))),
                "url": package.get("URL", ""),
                "group": group,
                "note": "Invoked as an external process for permitted media access." if canonical == "yt-dlp" else "",
                "_license": save_license(f"host-{package['Name']}", text),
            }
        )
    return credits


def curated_credits() -> list[dict[str, str]]:
    apache = (ROOT / "scripts" / "licenses" / "apache-2.0.txt").read_text(encoding="utf-8")
    mit = (ROOT / "LICENSE").read_text(encoding="utf-8")
    cc_by_3 = (ROOT / "scripts" / "licenses" / "cc-by-3.0.txt").read_text(encoding="utf-8")
    fluidr3_license = """FluidR3 General MIDI samples
Attribution: FluidR3 soundfont by Frank Wen; Copyright © 2000–2002, 2008 Frank Wen;
Copyright © 2008 Toby Smithe. Fluid contributors are quoted below.
MIDI.js MP3 rendering by gleitz/midi-js-soundfonts.
Source revision: 044fab8e1456bfafc5776e86dfd6bb8697149aef

The MIDI.js Soundfonts upstream README identifies its FluidR3_GM MP3
renditions as released under Creative Commons Attribution 3.0 US:
https://creativecommons.org/licenses/by/3.0/us/

Legal code:
https://creativecommons.org/licenses/by/3.0/us/legalcode

Source:
https://github.com/gleitz/midi-js-soundfonts/tree/044fab8e1456bfafc5776e86dfd6bb8697149aef/FluidR3_GM

The Debian copyright record below transcribes the original Fluid README's
copyright, contributors, and MIT notice for the underlying FluidR3_GM.sf2.
This original-source notice is separate from, and does not replace, the
CC BY 3.0 US license for the MIDI.js MP3 renditions distributed here:
https://sources.debian.org/data/main/f/fluid-soundfont/3.1-5.3/debian/copyright

Original Fluid contributors (quoted from its README):
"Fluid was constructed in part from samples found in the public domain that I
edited/cleaned/remixed/programmed and largely from recordings of my own and in
conjunction with the people below who helped along the way: Suren M. Seron
Scott Hanan Steve Aupperle Chris Gillman Alex Taubr Chris Prola Andrew Klenk
Winfried Hubbe Dylan Tim Gort Uros Katic Ethan Winer
(http://www.ethanwiner.com)"

Original Fluid MIT notice (for the underlying soundfont only):
Copyright © 2000–2002, 2008 Frank Wen
Copyright © 2008 Toby Smithe

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
DEALINGS IN THE SOFTWARE.

Mizan distributes selected minor-third root samples extracted from the
upstream MP3 data URIs without audio transcoding. These rendition assets
remain under the linked CC BY 3.0 US license; they are not relabeled MIT.
"""
    basic_pitch_license = "Copyright 2022 Spotify AB\n\n" + apache
    basic_pitch_notice = """Basic Pitch
Copyright 2022 Spotify AB

This product includes software developed at
Spotify AB (http://www.spotify.com/).

This product includes software from Librosa (ISC).
* Copyright (C) 2013--2017, librosa development team.

This product includes software from mir_eval (MIT)
* Copyright (C) 2014 Colin Raffel

This product includes software from numpy (BSD)
* Copyright (C) 2005-2022, NumPy Developers.

This product includes software from pretty-midi (MIT)
* Copyright (C) 2014 Colin Raffel

This product includes software from resampy (ISC)
* Copyright (C) 2016, Brian McFee

This product includes software from scipy (BSD)
* Copyright (C) 2001-2002 Enthought, Inc. 2003-2022, SciPy Developers

This product includes software from tensorflow (Apache 2.0)
* Copyright (C) 2019 Google, LLC <packages@tensorflow.org>

The tests for `basic-pitch` include audio files from the
Vocadito dataset liscened under Creative Commons
Attribution 4.0 International. The dataset can be found at:
https://zenodo.org/record/5578807#.YnRm5vPMKDU
"""
    save_license("model-basic-pitch", basic_pitch_license + "\n\nNOTICE\n\n" + basic_pitch_notice)
    save_license("model-htdemucs-6s", mit.replace(
        "Copyright (c) 2026 Ahmed Sabbour",
        "Copyright (c) 2019-present, Facebook, Inc. and its affiliates; ONNX conversion by StemSplit",
    ))
    save_license("model-beat-this", mit.replace(
        "Copyright (c) 2026 Ahmed Sabbour",
        "Copyright (c) 2024 Institute of Computational Perception, JKU Linz, Austria",
    ))
    archivo_license = (
        ROOT / "ui" / "node_modules" / "@fontsource-variable" / "archivo" / "LICENSE"
    ).read_text(encoding="utf-8")
    noto_license = (
        "Copyright 2022 The Noto Project Authors (https://github.com/notofonts/arabic)\n\n"
        + archivo_license[archivo_license.index("This Font Software"):]
    )
    save_license("font-noto-kufi-arabic", noto_license)
    save_license(
        "samples-salamander-grand-piano",
        "Salamander Grand Piano v3\nCopyright Alexander Holm\n\n" + cc_by_3,
    )
    save_license(
        "samples-sm-drums",
        "SM Drums\nSamples by Scott McLean, Tod Stillwell, and Suleiman Ali\n\n"
        "The distributor identifies these samples as Public Domain:\n"
        "https://sfzinstruments.github.io/drums/\n\n"
        "Project and author credits: https://smmdrums.wordpress.com/about/\n"
        "Source: https://github.com/sfzinstruments/SMDrums/tree/"
        "32cfbff5df7f33226dfd64d021a58beed8c71ba6\n\n"
        "Mizan bundles eight selected hits transcoded from WAV to Ogg Vorbis.\n"
        "Public Domain is the upstream designation; Mizan does not assign CC0\n"
        "or another license on the authors' behalf.\n",
    )
    save_license("samples-fluidr3-gm", fluidr3_license)
    save_license(
        "asset-webxr-generic-hands",
        (ROOT / "scripts" / "licenses" / "webxr-generic-hands.txt").read_text(encoding="utf-8"),
    )
    windows_mit = (OUTPUT_LICENSES / "host-onnxruntime-windowsml.txt").read_text(encoding="utf-8")
    return [
        {
            "name": "Spotify Basic Pitch ICASSP 2022 weights",
            "version": "fa5997af0a8210982619003269994a1be25eddf3",
            "license": "Apache-2.0",
            "author": "Copyright 2022 Spotify AB",
            "url": "https://github.com/spotify/basic-pitch/tree/fa5997af0a8210982619003269994a1be25eddf3",
            "group": "Models",
            "note": "Official ONNX weights; not bundled. Downloaded on first use and checksum verified; not converted by Mizan.",
            "_license": "licenses/model-basic-pitch.txt",
        },
        {
            "name": "HT-Demucs 6s ONNX weights",
            "version": "49df9b6989cf2150840ea65b0bef77a2e471b678",
            "license": "MIT",
            "author": "Meta AI Research; ONNX conversion by StemSplit",
            "url": "https://huggingface.co/StemSplitio/htdemucs-6s-onnx",
            "group": "Models",
            "note": "Six-stem fp16-stored-weight ONNX model; not bundled. Downloaded on first use and checksum verified.",
            "_license": "licenses/model-htdemucs-6s.txt",
        },
        {
            "name": "Beat This! final0 ONNX weights",
            "version": "e2c0d4376fac8141905a8312c1b327849751d59c",
            "license": "MIT",
            "author": "Institute of Computational Perception, JKU Linz; ONNX conversion by Hikari Tsai",
            "url": "https://huggingface.co/aaatmy/beat-this-onnx",
            "group": "Models",
            "note": "Beat/downbeat model and frontend constants; not bundled. Downloaded on first use and checksum verified.",
            "_license": "licenses/model-beat-this.txt",
        },
        {
            "name": "Python",
            "version": "3.12",
            "license": "PSF-2.0",
            "author": "Python Software Foundation",
            "url": "https://www.python.org/",
            "group": "Tools",
            "note": "The ARM64 runtime is bundled in the MSIX.",
            "_license": save_license(
                "tool-python",
                (Path(os.sys.base_prefix) / "LICENSE.txt").read_text(encoding="utf-8"),
            ),
        },
        {
            "name": ".NET Runtime",
            "version": "10",
            "license": "LicenseRef-Microsoft-.NET-Library",
            "author": "Microsoft Corporation",
            "url": "https://github.com/dotnet/runtime",
            "group": "Tools",
            "note": "The ARM64 runtime is bundled in the MSIX.",
            "_license": save_license(
                "tool-dotnet-runtime",
                (Path(os.environ["ProgramFiles"]) / "dotnet" / "LICENSE.txt").read_text(encoding="utf-8"),
            ),
        },
        {
            "name": "Windows App SDK Runtime",
            "version": "1.8.260921001",
            "license": "MIT",
            "author": "Copyright (c) Microsoft Corporation",
            "url": "https://learn.microsoft.com/windows/apps/windows-app-sdk/downloads",
            "group": "Tools",
            "note": "The self-contained ARM64 runtime is bundled in the MSIX.",
            "_license": save_license("tool-windows-app-sdk", windows_mit),
        },
        {
            "name": "Windows ML Runtime and execution provider catalog",
            "version": "1.8.260209005",
            "license": "MIT",
            "author": "Copyright (c) Microsoft Corporation",
            "url": "https://learn.microsoft.com/windows/ai/new-windows-ml/",
            "group": "Tools",
            "note": "CPU and DirectML are supplied through Windows ML. Optional catalog providers can have separate terms.",
            "_license": "licenses/tool-windows-app-sdk.txt",
        },
        {
            "name": "Qualcomm QNN execution provider",
            "version": "Catalog acquired",
            "license": "LicenseRef-Qualcomm-QNN",
            "author": "Qualcomm Technologies, Inc.",
            "url": "https://learn.microsoft.com/windows/ai/new-windows-ml/supported-execution-providers",
            "group": "Tools",
            "note": "Optional proprietary provider downloaded by Windows ML on supported devices; review its displayed terms before redistribution.",
        },
        {
            "name": "Microsoft Edge WebView2 Runtime",
            "version": "System installed",
            "license": "LicenseRef-Microsoft-WebView2-Runtime",
            "author": "Microsoft Corporation",
            "url": "https://developer.microsoft.com/microsoft-edge/webview2/",
            "group": "Tools",
            "note": "Required by the WinUI shell and pywebview development host; supplied by the evergreen system runtime.",
        },
        {
            "name": "Noto Kufi Arabic",
            "version": "Outlined glyphs in mizan-wordmark.svg",
            "license": "OFL-1.1",
            "author": "Copyright 2022 The Noto Project Authors",
            "url": "https://github.com/notofonts/arabic",
            "group": "Fonts & assets",
            "note": "Only outlined Arabic glyphs are embedded in the wordmark.",
            "_license": "licenses/font-noto-kufi-arabic.txt",
        },
        {
            "name": "Salamander Grand Piano v3 samples",
            "version": "Selected v5/v13 minor-third samples",
            "license": "CC-BY-3.0",
            "author": "Copyright Alexander Holm",
            "url": "https://github.com/sfzinstruments/SalamanderGrandPiano",
            "group": "Fonts & assets",
            "note": "Bundled subset transcoded from 48 kHz FLAC to Ogg Vorbis and trimmed to 12 seconds. Used for sampled piano and creative-track voices.",
            "_license": "licenses/samples-salamander-grand-piano.txt",
        },
        {
            "name": "SM Drums samples",
            "version": "32cfbff5df7f33226dfd64d021a58beed8c71ba6",
            "license": "Public Domain",
            "author": "Scott McLean, Tod Stillwell, and Suleiman Ali",
            "url": "https://github.com/sfzinstruments/SMDrums",
            "group": "Fonts & assets",
            "note": "Eight bundled acoustic-kit hits were selected and transcoded from WAV to Ogg Vorbis.",
            "_license": "licenses/samples-sm-drums.txt",
        },
        {
            "name": "WebXR generic hand models",
            "version": "f4992299601614adbfefd398dc8e281556bb7444",
            "license": "MIT",
            "author": "Copyright (c) 2019 Amazon",
            "url": "https://github.com/immersive-web/webxr-input-profiles/tree/f4992299601614adbfefd398dc8e281556bb7444/packages/assets/profiles/generic-hand",
            "group": "Fonts & assets",
            "note": "Bundled left and right connected hand models, unchanged except filenames; posed by Mizan for the optional 3D guitar and bass view.",
            "_license": "licenses/asset-webxr-generic-hands.txt",
        },
        {
            "name": "FluidR3 General MIDI samples",
            "version": "044fab8e1456bfafc5776e86dfd6bb8697149aef",
            "license": "CC-BY-3.0-US",
            "author": "FluidR3: Frank Wen; Copyright © 2000–2002, 2008 Frank Wen; Copyright © 2008 Toby Smithe; Fluid contributors; MIDI.js rendering by gleitz/midi-js-soundfonts",
            "url": "https://github.com/gleitz/midi-js-soundfonts/tree/044fab8e1456bfafc5776e86dfd6bb8697149aef/FluidR3_GM",
            "group": "Fonts & assets",
            "note": "Selected minor-third roots from all 128 GM programs are extracted from MP3 data URIs without transcoding. The license file separately documents the underlying FluidR3 soundfont's MIT copyright notice; the distributed renditions remain CC BY 3.0 US.",
            "_license": "licenses/samples-fluidr3-gm.txt",
        },
    ]


def render_notices(credits: list[dict[str, str]]) -> str:
    lines = [
        "# Third-party notices",
        "",
        "Mizan is a personal, non-commercial music-learning app. This file records the",
        "third-party software and assets used by the current source tree and installed",
        "production environment. A listing here does not change the component's license.",
        "Development and probe-only packages installed in the venv are excluded.",
        "",
    ]
    for group in GROUPS:
        lines += [f"## {group}", "", "| Name | Version | License | Copyright holder | Source |", "|---|---|---|---|---|"]
        for item in (credit for credit in credits if credit["group"] == group):
            license_text = item["license"]
            if path := item.get("_license"):
                license_text = f"[{license_text}]({path})"
            values = [item["name"], item["version"], license_text, item["author"], item["url"]]
            row = " | ".join(value.replace("|", "\\|").replace("\n", " ") for value in values)
            lines.append(f"| {row} |")
            if item.get("note"):
                lines.append(f"|  |  |  |  | *{item['note']}* |")
        lines.append("")
    lines += [
        "## Media, research, and inspiration",
        "",
        "- YouTube thumbnails and video/audio content are loaded at runtime. They are not",
        "  Mizan assets; copyright and other rights remain with their respective owners.",
        "- Recording alignment uses an independently implemented dynamic time warping",
        "  algorithm over beat chroma. No third-party DTW implementation is copied.",
        "- The chord-shape keyboard visualization is visually inspired by Hoffman Academy.",
        "  No Hoffman Academy code, artwork, or lesson content is included.",
        "",
        "## Planned but unused",
        "",
        "Transkun (MIT), hFT-Transformer (MIT code; checkpoint terms not separately stated),",
        "BTC (MIT repository), and ADTOF (CC-BY-NC-SA-4.0) remain candidates. They are not",
        "installed, bundled, downloaded, or used by the current engine.",
        "",
        "## Redistribution notes",
        "",
        "- Preserve the Apache-2.0 Basic Pitch license and NOTICE when redistributing the model.",
        "- Preserve the OFL-1.1 copyright and license with Archivo and the Noto Kufi outlines.",
        "- NumPy, SciPy, ONNX Runtime, and other packages carry bundled third-party notices;",
        "  their component-specific license files are retained in `licenses/`.",
        "- FFmpeg is a user-installed tool. Its license and linked libraries depend on the selected build.",
        "- Review Windows ML catalog-provider and WebView2 terms before shipping an installer.",
        "",
        "Mizan's own code is released under the MIT License (see `LICENSE`). The components",
        "listed here keep their own licenses.",
        "",
    ]
    return "\n".join(lines)


def _publish_licenses(staged: Path, destination: Path) -> None:
    files = sorted(staged.iterdir())
    names = {path.name for path in files}
    destination.mkdir(exist_ok=True)
    for source in files:
        source.replace(destination / source.name)
    for current in destination.iterdir():
        if current.is_file() and current.name not in names:
            current.unlink()


def main() -> None:
    global OUTPUT_LICENSES
    temporary = ROOT / ".credits-licenses"
    temporary_json = ROOT / ".credits.json"
    temporary_notices = ROOT / ".third-party-notices.md"
    if temporary.exists():
        shutil.rmtree(temporary)
    temporary.mkdir()
    OUTPUT_LICENSES = temporary
    try:
        credits = npm_credits() + python_credits() + curated_credits()
        credits.sort(key=lambda item: (GROUPS.index(item["group"]), item["name"].lower()))
        public = [{key: value for key, value in item.items() if not key.startswith("_") and value}
                  for item in credits]
        temporary_json.write_text(json.dumps(public, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")
        temporary_notices.write_text(render_notices(credits), encoding="utf-8")
        _publish_licenses(temporary, LICENSES)
        temporary_json.replace(ROOT / "ui" / "src" / "credits.json")
        temporary_notices.replace(ROOT / "THIRD_PARTY_NOTICES.md")
    finally:
        shutil.rmtree(temporary, ignore_errors=True)
        temporary_json.unlink(missing_ok=True)
        temporary_notices.unlink(missing_ok=True)
        OUTPUT_LICENSES = LICENSES
    print(f"Wrote {len(public)} credits and {len(list(LICENSES.iterdir()))} license files.")


if __name__ == "__main__":
    main()
