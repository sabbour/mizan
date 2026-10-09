import hashlib
import logging
from pathlib import Path
from threading import Event
import urllib.error
import urllib.request

from ..errors import ModelFailed
from ..paths import app_dir

logger = logging.getLogger(__name__)
BASIC_PITCH = {
    "id": "basic-pitch-icassp-2022",
    "version": "fa5997af0a8210982619003269994a1be25eddf3",
    "url": "https://raw.githubusercontent.com/spotify/basic-pitch/fa5997af0a8210982619003269994a1be25eddf3/basic_pitch/saved_models/icassp_2022/nmp.onnx",
    "sha256": "2c3c1d144bfa61ad236e92e169c13535c880469a12a047d4e73451f2c059a0ec",
    "license": "Apache-2.0",
    "providerOrder": ["cpu"],
}
HTDEMUCS_6S = {
    "id": "htdemucs-6s-fp16weights",
    "version": "49df9b6989cf2150840ea65b0bef77a2e471b678",
    "filename": "htdemucs_6s_fp16weights.onnx",
    "url": "https://huggingface.co/StemSplitio/htdemucs-6s-onnx/resolve/49df9b6989cf2150840ea65b0bef77a2e471b678/htdemucs_6s_fp16weights.onnx",
    "sha256": "7ce55792e2231c93fbf92de95f5fd5b3a5e6c89f7db690dfd693e8f1dce56869",
    "license": "MIT",
    "providerOrder": ["cpu"],
}
BEAT_THIS = {
    "id": "beat-this-final0",
    "version": "e2c0d4376fac8141905a8312c1b327849751d59c",
    "filename": "beat-this-final0.onnx",
    "url": "https://huggingface.co/aaatmy/beat-this-onnx/resolve/e2c0d4376fac8141905a8312c1b327849751d59c/beat-this-final0.onnx",
    "sha256": "e5e37b7d1802895e42559c5a1ced7619b1601d257a5c8e167c9d45de37c1b078",
    "license": "MIT",
    # DirectML returned finite but wrong Beat This! logits on Windows (irregular beats, lost
    # downbeats) for every cached song checked; CPU output matched the recordings.
    "providerOrder": ["cpu"],
}
BEAT_THIS_FRONTEND = {
    "id": "beat-this-final0-frontend",
    "version": BEAT_THIS["version"],
    "filename": "beat-this-final0-frontend.json",
    "url": "https://huggingface.co/aaatmy/beat-this-onnx/resolve/e2c0d4376fac8141905a8312c1b327849751d59c/frontend.json",
    "sha256": "7b2ba71db92b79cb33f45feb21854161de329b86a7e6ea686c3fec51ce85eb9f",
    "license": "MIT",
}


def checksum(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def ensure_model(spec: dict = BASIC_PITCH, cancelled: Event | None = None) -> Path:
    from .providers import check_cancel

    check_cancel(cancelled)
    target = app_dir("models") / spec.get("filename", f"{spec['id']}.onnx")
    if target.exists():
        if checksum(target) == spec["sha256"]:
            return target
        logger.warning("Cached model checksum mismatch: %s; downloading a verified replacement.", target.name)
    temporary = target.with_suffix(".partial")
    try:
        with urllib.request.urlopen(spec["url"], timeout=30) as response, temporary.open("wb") as output:
            while block := response.read(256 * 1024):
                check_cancel(cancelled)
                output.write(block)
        if checksum(temporary) != spec["sha256"]:
            raise ModelFailed(f"Model checksum mismatch for {spec['id']}.")
        check_cancel(cancelled)
        temporary.replace(target)
    except (urllib.error.URLError, OSError) as exc:
        raise ModelFailed(f"Cannot download {spec['id']}: {exc}") from exc
    finally:
        temporary.unlink(missing_ok=True)
    return target
