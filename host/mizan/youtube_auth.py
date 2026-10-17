from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
import os
from pathlib import Path
import shutil
import tempfile
from time import time

from .errors import InvalidYoutubeCookies
from .paths import home

_MAX_COOKIE_FILE_BYTES = 10 * 1024 * 1024
_COOKIE_SOURCE_FILENAME = "youtube-cookies-source.txt"


def youtube_cookies_path() -> Path:
    return home() / "youtube-cookies.txt"


def _source_path() -> Path:
    return youtube_cookies_path().with_name(_COOKIE_SOURCE_FILENAME)


def youtube_auth_status() -> dict[str, bool | str | None]:
    cookies = youtube_cookies_path()
    if not cookies.is_file():
        return {"signedIn": False, "source": None}
    try:
        if cookies.stat().st_size > _MAX_COOKIE_FILE_BYTES:
            return {"signedIn": False, "source": None}
        _validate_netscape_cookies(cookies.read_text(encoding="utf-8-sig"))
    except (InvalidYoutubeCookies, OSError, UnicodeError):
        return {"signedIn": False, "source": None}
    try:
        source = _source_path().read_text(encoding="ascii").strip()
    except (OSError, UnicodeError):
        source = "file"
    if source not in ("app", "file"):
        source = "file"
    return {"signedIn": True, "source": source}


@contextmanager
def youtube_cookies_for_operation() -> Iterator[Path | None]:
    source = youtube_cookies_path()
    if not source.is_file():
        yield None
        return

    with tempfile.TemporaryDirectory(prefix="mizan-youtube-") as directory:
        isolated = Path(directory) / "cookies.txt"
        try:
            shutil.copyfile(source, isolated)
            if isolated.stat().st_size > _MAX_COOKIE_FILE_BYTES:
                raise InvalidYoutubeCookies("Saved YouTube cookies exceed the supported size.")
            _validate_netscape_cookies(isolated.read_text(encoding="utf-8-sig"))
        except FileNotFoundError:
            yield None
            return
        except (InvalidYoutubeCookies, UnicodeError):
            yield None
            return
        yield isolated


def _validate_netscape_cookies(contents: str) -> None:
    lines = contents.splitlines()
    headers = [line.strip().lower() for line in lines if line.startswith("#")]
    if not any(header in ("# netscape http cookie file", "# http cookie file") for header in headers):
        raise InvalidYoutubeCookies("Choose a Netscape cookies.txt file.")

    youtube_cookie = False
    youtube_auth_cookie = False
    now = int(time())
    for line_number, line in enumerate(lines, 1):
        if not line or line.startswith("#") and not line.startswith("#HttpOnly_"):
            continue
        fields = line.split("\t")
        if len(fields) != 7:
            raise InvalidYoutubeCookies(f"Cookie file line {line_number} is not in Netscape format.")
        domain, include_subdomains, path, secure, expiry, name, value = fields
        if domain.startswith("#HttpOnly_"):
            domain = domain[len("#HttpOnly_"):]
        normalized_domain = domain.lstrip(".").lower()
        if expiry and (not expiry.isascii() or not expiry.isdigit()):
            raise InvalidYoutubeCookies(f"Cookie file line {line_number} is not in Netscape format.") from None
        expiry_seconds = int(expiry) if expiry else 0
        if (not domain or include_subdomains.upper() not in ("TRUE", "FALSE")
                or domain.startswith(".") != (include_subdomains.upper() == "TRUE")
                or not path.startswith("/") or secure.upper() not in ("TRUE", "FALSE")
                or not name or any(char in value for char in "\r\n\t")):
            raise InvalidYoutubeCookies(f"Cookie file line {line_number} is not in Netscape format.")
        if normalized_domain == "youtube.com" or normalized_domain.endswith(".youtube.com"):
            youtube_cookie = True
            if (name in ("SAPISID", "__Secure-3PAPISID") and value
                    and (expiry_seconds == 0 or expiry_seconds > now)):
                youtube_auth_cookie = True
    if not youtube_cookie:
        raise InvalidYoutubeCookies("The cookies.txt file must contain at least one youtube.com cookie.")
    if not youtube_auth_cookie:
        raise InvalidYoutubeCookies("The cookies.txt file must contain an active YouTube sign-in session.")


def import_youtube_cookies(path: str) -> dict[str, bool | str | None]:
    if type(path) is not str or not path.strip():
        raise InvalidYoutubeCookies("Choose a cookies.txt file.")
    source = Path(path.strip())
    try:
        size = source.stat().st_size
        if not source.is_file() or size > _MAX_COOKIE_FILE_BYTES:
            raise InvalidYoutubeCookies("Choose a cookies.txt file smaller than 10 MB.")
        contents = source.read_text(encoding="utf-8-sig")
    except InvalidYoutubeCookies:
        raise
    except (OSError, UnicodeError) as exc:
        raise InvalidYoutubeCookies("Mizan could not read that cookies.txt file.") from exc
    _validate_netscape_cookies(contents)

    target = youtube_cookies_path()
    temporary = target.with_name(target.name + ".tmp")
    try:
        temporary.write_text(contents, encoding="utf-8", newline="")
        os.replace(temporary, target)
        _source_path().write_text("file\n", encoding="ascii")
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass
    return youtube_auth_status()


def youtube_sign_out() -> dict[str, bool | str | None]:
    for path in (youtube_cookies_path(), _source_path()):
        try:
            path.unlink()
        except FileNotFoundError:
            pass
    return youtube_auth_status()
