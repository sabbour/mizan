import mimetypes
import secrets
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Lock, Thread
from urllib.parse import quote, urlsplit


class ArtifactServer:
    def __init__(self):
        self._files: dict[str, Path] = {}
        self._urls: dict[Path, str] = {}
        self._lock = Lock()
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                self._serve(False)

            def do_HEAD(self):
                self._serve(True)

            def _serve(self, head: bool):
                with owner._lock:
                    path = owner._files.get(urlsplit(self.path).path)
                if path is None or not path.is_file():
                    self.send_error(404)
                    return
                size, start, end = path.stat().st_size, 0, path.stat().st_size - 1
                range_header = self.headers.get("Range")
                if range_header:
                    try:
                        first, last = range_header.removeprefix("bytes=").split("-", 1)
                        start = int(first)
                        end = min(int(last), size - 1) if last else size - 1
                        if start < 0 or start > end or start >= size:
                            raise ValueError
                    except ValueError:
                        self.send_response(416)
                        self.send_header("Content-Range", f"bytes */{size}")
                        self.end_headers()
                        return
                length = end - start + 1
                self.send_response(206 if range_header else 200)
                self.send_header("Content-Type", mimetypes.guess_type(path.name)[0] or "application/octet-stream")
                self.send_header("Content-Length", str(length))
                self.send_header("Accept-Ranges", "bytes")
                self.send_header("Access-Control-Allow-Origin", "*")
                if range_header:
                    self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
                self.end_headers()
                if head:
                    return
                with path.open("rb") as stream:
                    stream.seek(start)
                    self.wfile.write(stream.read(length))

            def log_message(self, format, *args):
                pass

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._thread = Thread(target=self._server.serve_forever, name="mizan-artifacts", daemon=True)
        self._thread.start()

    def url(self, path: str | Path) -> str:
        resolved = Path(path).resolve(strict=True)
        with self._lock:
            existing = self._urls.get(resolved)
            if existing:
                return existing
            route = f"/artifact/{secrets.token_urlsafe(24)}/{quote(resolved.name)}"
            self._files[route] = resolved
            url = f"http://127.0.0.1:{self._server.server_port}{route}"
            self._urls[resolved] = url
            return url

    def close(self) -> None:
        self._server.shutdown()
        self._server.server_close()
        self._thread.join()
