import re
from urllib.parse import parse_qs, urlsplit

from .errors import InvalidUrl


def parse_video_id(url: str) -> str:
    if not isinstance(url, str):
        raise InvalidUrl()
    url = url.strip()
    if not url or any(char.isspace() or ord(char) < 32 for char in url):
        raise InvalidUrl()
    try:
        parsed = urlsplit(url)
        if (
            parsed.scheme not in ("http", "https")
            or parsed.username is not None
            or parsed.password is not None
            or parsed.port is not None
        ):
            raise InvalidUrl()
        host = parsed.hostname
    except ValueError as exc:
        raise InvalidUrl() from exc

    video_id = ""
    if host == "youtu.be":
        video_id = parsed.path.removeprefix("/")
    elif host in ("youtube.com", "www.youtube.com", "music.youtube.com", "m.youtube.com"):
        if parsed.path == "/watch":
            values = parse_qs(parsed.query, keep_blank_values=True).get("v", [])
            if len(values) == 1:
                video_id = values[0]
        elif parsed.path.startswith("/shorts/"):
            video_id = parsed.path.removeprefix("/shorts/")
    if not re.fullmatch(r"[A-Za-z0-9_-]{11}", video_id):
        raise InvalidUrl()
    return video_id
