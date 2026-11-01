"""Serveur HTTP du registre : sert le contenu signé, avec ETag basé sur le serial."""

from __future__ import annotations

import json
import logging
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from geniusdns.common.protocol import PROTOCOL_VERSION, sign
from geniusdns.registry.store import RegistryStore

log = logging.getLogger("geniusdns.registry")


class RegistryServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address: tuple[str, int], store: RegistryStore, private_key: str):
        super().__init__(address, _Handler)
        self.store = store
        self.private_key = private_key


class _Handler(BaseHTTPRequestHandler):
    server: RegistryServer
    server_version = "GeniusDNS"

    def do_GET(self) -> None:
        path = self.path.split("?", 1)[0]
        if path == "/health":
            self._send(200, b"ok", "text/plain")
        elif path == "/v1/registry":
            self._registry()
        else:
            self._send(404, b"not found", "text/plain")

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
