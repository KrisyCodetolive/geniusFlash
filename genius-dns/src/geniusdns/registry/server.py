"""Serveur HTTP du registre.

- GET  /v1/registry            contenu signé, avec ETag basé sur le serial (lu par les agents)
- *    /v1/admin/entries[/nom] gestion des entrées, protégée par un jeton Bearer (lu par le CLI)
- GET  /download/[fichier]     exécutables à télécharger (agent, etc.)
"""

from __future__ import annotations

import hmac
import json
import logging
import re
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote

from geniusdns.common.protocol import PROTOCOL_VERSION, RegistryError, sign
from geniusdns.registry.store import RegistryStore

log = logging.getLogger("geniusdns.registry")

_SAFE_FILENAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
_MAX_BODY = 1024


class RegistryServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(
        self,
        address: tuple[str, int],
        store: RegistryStore,
        private_key: str,
        admin_token: str | None = None,
        downloads_dir: str | Path | None = None,
    ):
        super().__init__(address, _Handler)
        self.store = store
        self.private_key = private_key
        self.admin_token = admin_token or None
        self.downloads_dir = Path(downloads_dir) if downloads_dir else None


class _Handler(BaseHTTPRequestHandler):
    server: RegistryServer
    server_version = "GeniusDNS"

    # --- routage -----------------------------------------------------------------

    def do_GET(self) -> None:
        path = self.path.split("?", 1)[0]
        if path == "/health":
            self._send(200, b"ok", "text/plain")
        elif path == "/v1/registry":
            self._registry()
        elif path == "/v1/admin/entries":
            self._admin(self._admin_list)
        elif path == "/download" or path.startswith("/download/"):
            self._download(path[len("/download/"):] if path != "/download" else "")
        else:
            self._send(404, b"not found", "text/plain")

    def do_PUT(self) -> None:
        name = self._entry_name()
        if name is None:
            return self._send(404, b"not found", "text/plain")
        self._admin(lambda: self._admin_put(name))

    def do_DELETE(self) -> None:
        name = self._entry_name()
        if name is None:
            return self._send(404, b"not found", "text/plain")
        self._admin(lambda: self._admin_delete(name))

    def _entry_name(self) -> str | None:
        prefix = "/v1/admin/entries/"
        path = self.path.split("?", 1)[0]
        return unquote(path[len(prefix):]) if path.startswith(prefix) and len(path) > len(prefix) else None

    # --- agents ------------------------------------------------------------------

    def _registry(self) -> None:
        snapshot = self.server.store.load()
        etag = f'"{snapshot["serial"]}"'
        if self.headers.get("If-None-Match") == etag:
            self.send_response(304)
            self.send_header("ETag", etag)
            self.end_headers()
            return
        payload = {
            "version": PROTOCOL_VERSION,
            "serial": snapshot["serial"],
            "issued_at": int(time.time()),
            "entries": snapshot["entries"],
        }
        body = json.dumps(sign(self.server.private_key, payload)).encode("utf-8")
        self._send(200, body, "application/json", etag=etag)

    # --- administration ----------------------------------------------------------

    def _admin(self, action) -> None:
        token = self.server.admin_token
        if token is None:
            return self._json(404, {"error": "administration à distance désactivée"})
        header = self.headers.get("Authorization", "")
        if not header.startswith("Bearer ") or not hmac.compare_digest(header[7:], token):
            log.warning("jeton refusé depuis %s", self.address_string())
            return self._json(401, {"error": "jeton invalide"})
        try:
            action()
        except RegistryError as exc:
            self._json(400, {"error": str(exc)})

    def _admin_list(self) -> None:
        self._json(200, self.server.store.load())

    def _admin_put(self, name: str) -> None:
        length = int(self.headers.get("Content-Length") or 0)
        if length > _MAX_BODY:
            return self._json(413, {"error": "corps trop grand"})
        try:
            ip = json.loads(self.rfile.read(length) or b"{}")["ip"]
        except (ValueError, KeyError, TypeError):
            return self._json(400, {"error": 'corps attendu : {"ip": "..."}'})
        self.server.store.set(name, ip)
        self._json(200, self.server.store.load())

    def _admin_delete(self, name: str) -> None:
        removed = self.server.store.remove(name)
        self._json(200 if removed else 404, {"removed": removed})

    # --- téléchargements ---------------------------------------------------------

    def _download(self, filename: str) -> None:
        directory = self.server.downloads_dir
        if directory is None or not directory.is_dir():
            return self._send(404, b"aucun dossier de telechargement", "text/plain")
        if not filename:
            files = sorted(p.name for p in directory.iterdir() if p.is_file() and _SAFE_FILENAME.match(p.name))
            return self._send(200, ("\n".join(files) + "\n").encode(), "text/plain; charset=utf-8")
        target = directory / unquote(filename)
        if not _SAFE_FILENAME.match(target.name) or target.parent != directory or not target.is_file():
            return self._send(404, b"not found", "text/plain")
        size = target.stat().st_size
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(size))
        self.send_header("Content-Disposition", f'attachment; filename="{target.name}"')
        self.end_headers()
        with open(target, "rb") as handle:
            while chunk := handle.read(65536):
                self.wfile.write(chunk)

    # --- réponses ----------------------------------------------------------------

    def _json(self, status: int, data: dict) -> None:
        self._send(status, json.dumps(data).encode("utf-8"), "application/json")

    def _send(self, status: int, body: bytes, content_type: str, etag: str | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        if etag:
            self.send_header("ETag", etag)
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args) -> None:  # noqa: A002
        log.info("%s - %s", self.address_string(), format % args)
