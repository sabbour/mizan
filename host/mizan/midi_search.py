from __future__ import annotations

import hashlib
import html
import json
import re
from pathlib import PurePosixPath
from html.parser import HTMLParser
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, quote, urlencode, urljoin, urlsplit, urlunsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from .errors import InvalidFile, InvalidSearch, MidiSearchFailed

MAX_MIDI_BYTES = 2 * 1024 * 1024
COMMONS_HOSTS = frozenset({"commons.wikimedia.org", "upload.wikimedia.org"})
MUTOPIA_HOSTS = frozenset({"www.mutopiaproject.org"})
ARCHIVE_HOSTS = frozenset({"archive.org"})
ARCHIVE_DOWNLOAD_HOSTS = frozenset({"archive.org", "*.archive.org"})
COMMONS_API = "https://commons.wikimedia.org/w/api.php"
MUTOPIA_SEARCH = "https://www.mutopiaproject.org/cgibin/make-table.cgi"
ARCHIVE_SEARCH = "https://archive.org/advancedsearch.php"
ARCHIVE_CC0_URL = "http://creativecommons.org/publicdomain/zero/1.0/"


def validate_query(query: str) -> str:
    if not isinstance(query, str) or len(query.strip()) > 200:
        raise InvalidSearch()
    return query.strip()


def _clean_html(value: object) -> str:
    if not isinstance(value, str):
        return ""

    class Text(HTMLParser):
        def __init__(self):
            super().__init__(convert_charrefs=True)
            self.parts: list[str] = []
            self.hidden_depth = 0

        def handle_starttag(self, tag: str, _attrs) -> None:
            if tag in ("script", "style"):
                self.hidden_depth += 1

        def handle_endtag(self, tag: str) -> None:
            if tag in ("script", "style") and self.hidden_depth:
                self.hidden_depth -= 1

        def handle_data(self, data: str) -> None:
            if not self.hidden_depth:
                self.parts.append(data)

    parser = Text()
    parser.feed(html.unescape(value))
    return re.sub(r"\s+", " ", " ".join(parser.parts)).strip()


def _license_name(value: str) -> str | None:
    name = re.sub(r"\s+", " ", value.strip()).casefold()
    if re.match(r"^(?:public domain)(?:\b|$)", name):
        return "Public Domain"
    if re.match(r"^(?:cc0|creative commons zero)(?:\b|$)", name):
        return "CC0"
    if re.match(r"^(?:cc by-sa|creative commons attribution[- ]sharealike)(?![\w-])", name):
        return "CC BY-SA"
    if re.match(r"^(?:cc by|creative commons attribution)(?![\w-])", name):
        return "CC BY"
    return None


def _validate_url(url: str, allowed_hosts: frozenset[str]) -> str:
    if not isinstance(url, str) or len(url) > 4096:
        raise ValueError("A URL is required.")
    try:
        parsed = urlsplit(url)
        port = parsed.port
    except ValueError as exc:
        raise ValueError("The URL is invalid.") from exc
    host = (parsed.hostname or "").casefold()
    approved = any(
        host == allowed or allowed.startswith("*.") and host.endswith(allowed[1:])
        for allowed in allowed_hosts
    )
    if (parsed.scheme != "https" or not approved
            or parsed.username or parsed.password or port not in (None, 443)):
        raise ValueError("The URL is not on an approved HTTPS host.")
    return url


def _file_url_key(url: str) -> str:
    parsed = urlsplit(url)
    normalized = urlunsplit(("https", (parsed.hostname or "").casefold(), parsed.path, parsed.query, ""))
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


class _ApprovedRedirects(HTTPRedirectHandler):
    def __init__(self, allowed_hosts: frozenset[str]):
        super().__init__()
        self.allowed_hosts = allowed_hosts

    def redirect_request(self, request, fp, code, message, headers, new_url):
        url = urljoin(request.full_url, new_url)
        _validate_url(url, self.allowed_hosts)
        return super().redirect_request(request, fp, code, message, headers, url)


def _request_bytes(url: str, allowed_hosts: frozenset[str], limit: int = MAX_MIDI_BYTES) -> bytes:
    _validate_url(url, allowed_hosts)
    opener = build_opener(_ApprovedRedirects(allowed_hosts))
    request = Request(url, headers={"User-Agent": "Mizan/0.1 (MIDI search)"})
    try:
        with opener.open(request, timeout=8) as response:
            _validate_url(response.geturl(), allowed_hosts)
            length = response.headers.get("Content-Length")
            if length and int(length) > limit:
                raise InvalidFile("The MIDI file is larger than 2 MB.")
            data = response.read(limit + 1)
    except InvalidFile:
        raise
    except (HTTPError, URLError, TimeoutError, OSError, ValueError) as exc:
        raise MidiSearchFailed() from exc
    if len(data) > limit:
        raise InvalidFile("The MIDI file is larger than 2 MB.")
    return data


def _page_list(value: object) -> list[dict]:
    if isinstance(value, list):
        return [item for item in value if isinstance(item, dict)]
    if isinstance(value, dict):
        return [item for item in value.values() if isinstance(item, dict)]
    return []


def parse_commons_response(payload: dict) -> list[dict]:
    query = payload.get("query")
    if not isinstance(query, dict):
        return []
    pages = _page_list(query.get("pages"))

    def index(page: dict) -> int:
        try:
            return int(page.get("index", 2**31))
        except (TypeError, ValueError):
            return 2**31

    results = []
    for page in sorted(pages, key=index):
        imageinfo = page.get("imageinfo")
        if not isinstance(imageinfo, list) or not imageinfo or not isinstance(imageinfo[0], dict):
            continue
        image = imageinfo[0]
        metadata = image.get("extmetadata")
        if not isinstance(metadata, dict):
            continue

        def metadata_text(key: str) -> str:
            value = metadata.get(key)
            return _clean_html(value.get("value")) if isinstance(value, dict) else ""

        fields = {
            key: metadata_text(key)
            for key in ("LicenseShortName", "LicenseUrl", "Artist", "Credit", "UsageTerms", "AttributionRequired")
        }
        license_name = _license_name(fields["LicenseShortName"] or fields["UsageTerms"])
        file_url = image.get("url")
        source_url = image.get("descriptionurl")
        mime = str(image.get("mime") or "").casefold()
        title = _clean_html(page.get("title")).removeprefix("File:").strip()
        if (not license_name or not isinstance(file_url, str)
                or mime not in ("audio/midi", "audio/x-midi", "application/x-midi")
                or not isinstance(source_url, str)):
            continue
        try:
            if not urlsplit(file_url).path.lower().endswith((".mid", ".midi")):
                continue
            _validate_url(file_url, COMMONS_HOSTS)
            _validate_url(source_url, frozenset({"commons.wikimedia.org"}))
        except ValueError:
            continue
        artist = fields["Artist"][:300] or None
        credit = fields["Credit"][:1000] or artist or None
        attribution_required = fields["AttributionRequired"].casefold() in ("true", "yes", "1")
        if (license_name in ("CC BY", "CC BY-SA") or attribution_required) and not credit:
            continue
        license_url = fields["LicenseUrl"] or None
        if license_url:
            try:
                _validate_url(license_url, frozenset({"creativecommons.org", "commons.wikimedia.org"}))
            except ValueError:
                license_url = None
        results.append({
            "id": f"commons:{page.get('pageid') or hashlib.sha256(file_url.encode()).hexdigest()}",
            "dedupeKey": _file_url_key(file_url),
            "provider": "commons",
            "source": "Wikimedia Commons",
            "title": title[:300] or "Untitled MIDI",
            "artist": artist,
            "license": license_name,
            "licenseUrl": license_url,
            "attribution": credit or f"Attribution not required ({license_name})",
            "url": file_url,
            "sourceUrl": source_url,
        })
        if len(results) == 5:
            break
    return results


class _MutopiaResults(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.current: dict | None = None
        self.results: list[dict] = []
        self.cell: list[str] | None = None
        self.link: dict | None = None
        self.table_depth = 0
        self.hidden_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attrs = dict(attrs)
        if tag in ("script", "style"):
            self.hidden_depth += 1
            return
        if tag == "table":
            if self.current is None and "result-table" in (attrs.get("class") or "").split():
                self.current = {"cells": [], "links": []}
                self.table_depth = 1
            elif self.current is not None:
                self.table_depth += 1
        if self.current is None:
            return
        if tag in ("td", "th"):
            self.cell = []
        if tag == "a":
            self.link = {"href": attrs.get("href"), "class": attrs.get("class") or "", "text": []}

    def handle_data(self, data: str) -> None:
        if self.current is None or self.hidden_depth:
            return
        if self.cell is not None:
            self.cell.append(data)
        if self.link is not None:
            self.link["text"].append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag in ("script", "style") and self.hidden_depth:
            self.hidden_depth -= 1
            return
        if self.current is None:
            return
        if tag in ("td", "th") and self.cell is not None:
            self.current["cells"].append(re.sub(r"\s+", " ", " ".join(self.cell)).strip())
            self.cell = None
        if tag == "a" and self.link is not None:
            link = self.link
            link["text"] = re.sub(r"\s+", " ", " ".join(link["text"])).strip()
            self.current["links"].append(link)
            self.link = None
        if tag == "table":
            self.table_depth -= 1
            if self.table_depth == 0:
                self.results.append(self.current)
                self.current = None


def _parse_mutopia_items(items: list[dict]) -> list[dict]:
    results = []
    for item in items:
        links = item["links"]
        def is_midi(link: dict) -> bool:
            try:
                return urlsplit(link.get("href") or "").path.lower().endswith((".mid", ".midi"))
            except ValueError:
                return False

        midi_link = next((link for link in links if is_midi(link)), None)
        license_link = next((link for link in links
                             if "legal.html#" in (link.get("href") or "").lower()), None)
        info_link = next((link for link in links
                          if "piece-info.cgi" in (link.get("href") or "").lower()), None)
        if not midi_link or not license_link or not info_link:
            continue
        fragment = urlsplit(urljoin(MUTOPIA_SEARCH, license_link["href"])).fragment.lower()
        license_name = {"publicdomain": "Public Domain", "ccasa": "CC BY-SA", "cca": "CC BY"}.get(fragment)
        if not license_name:
            continue
        file_url = urljoin(MUTOPIA_SEARCH, midi_link["href"])
        source_url = urljoin(MUTOPIA_SEARCH, info_link["href"])
        license_url = urljoin(MUTOPIA_SEARCH, license_link["href"])
        try:
            _validate_url(file_url, MUTOPIA_HOSTS)
            _validate_url(source_url, MUTOPIA_HOSTS)
            _validate_url(license_url, MUTOPIA_HOSTS)
        except ValueError:
            continue
        cells = [cell for cell in item["cells"] if cell]
        artist = None
        for index, cell in enumerate(cells[:-1]):
            if cell.casefold().rstrip(":") in ("composer", "by", "author"):
                artist = cells[index + 1][:300]
                break
        title = next((link["text"] for link in links
                      if link["text"] and "title" in link.get("class", "").casefold()), None)
        if not title:
            for index, cell in enumerate(cells[:-1]):
                if cell.casefold().rstrip(":") in ("title", "piece", "work"):
                    title = cells[index + 1]
                    break
        if not title:
            title = next((cell for cell in cells
                          if cell.casefold().rstrip(":") not in (
                              "title", "piece", "work", "composer", "by", "author",
                              "instruments", "instrument", "license", "midi",
                          )), None)
        if not title:
            title = next((link["text"] for link in links
                          if link["text"] and "piece-info.cgi" not in (link.get("href") or "").lower()), None)
        if not title:
            continue
        if license_name in ("CC BY", "CC BY-SA") and not artist:
            continue
        piece_id = parse_qs(urlsplit(source_url).query).get("id", [""])[0]
        results.append({
            "id": f"mutopia:{piece_id or hashlib.sha256(file_url.encode()).hexdigest()}",
            "dedupeKey": _file_url_key(file_url),
            "provider": "mutopia",
            "source": "Mutopia Project",
            "title": title[:300],
            "artist": artist,
            "license": license_name,
            "licenseUrl": license_url,
            "attribution": f"Composer: {artist}" if artist else f"Attribution not required ({license_name})",
            "url": file_url,
            "sourceUrl": source_url,
        })
    return results[:10]


def parse_mutopia_response(document: str) -> list[dict]:
    parser = _MutopiaResults()
    parser.feed(document)
    return _parse_mutopia_items(parser.results)


def _archive_download_url(identifier: str, name: str) -> str:
    return f"https://archive.org/download/{identifier}/{quote(name, safe='')}"


def parse_archive_item(identifier: str, payload: dict, search_license: str | None = None) -> list[dict]:
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,200}", identifier, re.ASCII):
        return []
    item = payload.get("metadata")
    files = payload.get("files")
    if (not isinstance(item, dict) or item.get("identifier") != identifier
            or not isinstance(files, list)):
        return []
    license_url = item.get("licenseurl")
    if license_url != ARCHIVE_CC0_URL or search_license not in (None, ARCHIVE_CC0_URL):
        return []
    title = _clean_html(item.get("title"))[:300] or identifier
    creator = item.get("creator")
    if isinstance(creator, list):
        artist = "; ".join(_clean_html(value) for value in creator if isinstance(value, str))[:300] or None
    else:
        artist = _clean_html(creator)[:300] or None
    midi_files = []
    for file in files:
        if not isinstance(file, dict) or file.get("source") != "original":
            continue
        name = file.get("name")
        if (not isinstance(name, str) or not name or ".." in PurePosixPath(name).parts
                or not (str(file.get("format") or "").casefold() == "midi"
                        or name.casefold().endswith((".mid", ".midi")))):
            continue
        try:
            size = int(file.get("size"))
        except (TypeError, ValueError):
            continue
        if size <= 0 or size > MAX_MIDI_BYTES:
            continue
        hashes = {}
        for algorithm in ("md5", "sha1", "sha256"):
            value = file.get(algorithm)
            length = {"md5": 32, "sha1": 40, "sha256": 64}[algorithm]
            if isinstance(value, str) and re.fullmatch(fr"[0-9a-fA-F]{{{length}}}", value):
                hashes[algorithm] = value.casefold()
        file_url = _archive_download_url(identifier, name)
        try:
            _validate_url(file_url, ARCHIVE_HOSTS)
        except ValueError:
            continue
        midi_files.append((file, name, size, hashes, file_url))

    results = []
    for file, name, size, hashes, file_url in midi_files:
        file_stem = PurePosixPath(name).stem
        display_title = title if len(midi_files) == 1 else f"{title} — {file_stem}"[:300]
        results.append({
            "id": f"archive:{identifier}:{hashlib.sha256(name.encode('utf-8')).hexdigest()[:16]}",
            "dedupeKey": _file_url_key(file_url),
            "provider": "archive",
            "source": "Internet Archive",
            "title": display_title,
            "artist": artist,
            "license": "CC0",
            "licenseUrl": "https://creativecommons.org/publicdomain/zero/1.0/",
            "attribution": f"Creator: {artist}" if artist else "Attribution not required (CC0)",
            "url": file_url,
            "sourceUrl": f"https://archive.org/details/{identifier}",
            "identifier": identifier,
            "fileName": name,
            "size": size,
            "hashes": hashes,
            "_licenseUrl": license_url,
        })
    return results


def search_commons(query: str) -> list[dict]:
    text = validate_query(query)
    if not text:
        return []
    params = urlencode({
        "action": "query",
        "generator": "search",
        "gsrsearch": f"{text} filemime:audio/midi",
        "gsrnamespace": 6,
        "gsrlimit": 5,
        "prop": "imageinfo",
        "iiprop": "url|mime|size|extmetadata",
        "iiextmetadatafilter": "LicenseShortName|LicenseUrl|Artist|Credit|UsageTerms|AttributionRequired",
        "format": "json",
        "formatversion": 2,
    })
    try:
        payload = json.loads(_request_bytes(f"{COMMONS_API}?{params}", frozenset({"commons.wikimedia.org"})))
    except MidiSearchFailed:
        raise
    except (UnicodeDecodeError, json.JSONDecodeError, TypeError) as exc:
        raise MidiSearchFailed() from exc
    if not isinstance(payload, dict):
        raise MidiSearchFailed()
    return parse_commons_response(payload)


def search_mutopia(query: str, startat: int = 0) -> tuple[list[dict], int | None]:
    text = validate_query(query)
    if (type(startat) is not int or startat < 0 or startat > 10000 or startat % 10):
        raise InvalidSearch("Mutopia pagination must use a non-negative page offset in steps of 10.")
    if not text:
        return [], None
    params = urlencode({"searchingfor": text, "Instrument": "Piano", "startat": startat})
    try:
        document = _request_bytes(f"{MUTOPIA_SEARCH}?{params}", MUTOPIA_HOSTS).decode("utf-8", errors="replace")
    except MidiSearchFailed:
        raise
    parser = _MutopiaResults()
    parser.feed(document)
    results = _parse_mutopia_items(parser.results)
    return results, startat + 10 if len(parser.results) == 10 else None


def _archive_query(query: str) -> str:
    terms = [term for term in query.split() if term]
    escaped_terms = [
        '"' + re.sub(r'([+\-&|!(){}\[\]^"~*?:\\/])', r"\\\1", term) + '"'
        for term in terms
    ]
    base = f'format:"MIDI" AND licenseurl:"{ARCHIVE_CC0_URL}"'
    return f"{base} AND {' AND '.join(escaped_terms)}" if escaped_terms else base


def search_archive(query: str) -> list[dict]:
    text = validate_query(query)
    if not text:
        return []
    params = urlencode([
        ("q", _archive_query(text)),
        ("fl[]", "identifier"),
        ("fl[]", "title"),
        ("fl[]", "licenseurl"),
        ("rows", 5),
        ("page", 1),
        ("output", "json"),
    ])
    try:
        payload = json.loads(_request_bytes(f"{ARCHIVE_SEARCH}?{params}", ARCHIVE_HOSTS))
    except MidiSearchFailed:
        raise
    except (UnicodeDecodeError, json.JSONDecodeError, TypeError) as exc:
        raise MidiSearchFailed() from exc
    if not isinstance(payload, dict):
        raise MidiSearchFailed()
    docs = ((payload.get("response") or {}).get("docs")
            if isinstance(payload.get("response"), dict) else None)
    if not isinstance(docs, list):
        raise MidiSearchFailed()
    results = []
    metadata_attempts = metadata_failures = 0
    for doc in docs[:5]:
        if not isinstance(doc, dict):
            continue
        identifier, license_url = doc.get("identifier"), doc.get("licenseurl")
        if (not isinstance(identifier, str)
                or not re.fullmatch(r"[A-Za-z0-9._-]{1,200}", identifier, re.ASCII)
                or license_url != ARCHIVE_CC0_URL):
            continue
        metadata_attempts += 1
        try:
            metadata_url = f"https://archive.org/metadata/{quote(identifier, safe='')}"
            metadata = json.loads(_request_bytes(metadata_url, ARCHIVE_HOSTS))
        except MidiSearchFailed:
            metadata_failures += 1
            logger.warning("Archive metadata unavailable for item %s", identifier)
            continue
        except (UnicodeDecodeError, json.JSONDecodeError, TypeError):
            metadata_failures += 1
            continue
        results.extend(parse_archive_item(identifier, metadata, license_url))
    if metadata_attempts and metadata_failures == metadata_attempts and not results:
        raise MidiSearchFailed()
    return results[:10]


def download_midi(result: dict) -> bytes:
    provider = result.get("provider")
    if provider == "commons":
        hosts = COMMONS_HOSTS
        source_hosts = frozenset({"commons.wikimedia.org"})
    elif provider == "mutopia":
        hosts = MUTOPIA_HOSTS
        source_hosts = MUTOPIA_HOSTS
    elif provider == "archive":
        hosts = ARCHIVE_DOWNLOAD_HOSTS
        source_hosts = ARCHIVE_HOSTS
    else:
        raise InvalidFile("This MIDI result has an unknown provider.")
    url, source_url = result.get("url"), result.get("sourceUrl")
    try:
        _validate_url(url, hosts)
        _validate_url(source_url, source_hosts)
    except ValueError as exc:
        raise InvalidFile("This MIDI result does not use an approved HTTPS URL.") from exc
    if not urlsplit(url).path.lower().endswith((".mid", ".midi")):
        raise InvalidFile("The approved provider URL is not a MIDI file.")
    if not _license_name(str(result.get("license") or "")):
        raise InvalidFile("The per-file license is not an approved license.")
    if provider == "archive":
        if (result.get("_licenseUrl") != ARCHIVE_CC0_URL
                or url != _archive_download_url(result.get("identifier"), result.get("fileName"))):
            raise InvalidFile("This Archive file does not have a confirmed per-item CC0 license.")
        expected_size = result.get("size")
        if type(expected_size) is not int or expected_size <= 0 or expected_size > MAX_MIDI_BYTES:
            raise InvalidFile("The Archive file size is not valid.")
    data = _request_bytes(url, hosts)
    if provider == "archive":
        if len(data) != expected_size:
            raise InvalidFile("The downloaded file size does not match Archive metadata.")
        for algorithm, expected in result.get("hashes", {}).items():
            digest = hashlib.new(algorithm, data).hexdigest()
            if digest != expected:
                raise InvalidFile("The downloaded file hash does not match Archive metadata.")
    if not data.startswith(b"MThd"):
        raise InvalidFile("The downloaded file does not have a MIDI header.")
    return data
