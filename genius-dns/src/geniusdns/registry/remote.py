"""Client de l'API d'administration, utilisé par le CLI quand --server est donné."""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request

from geniusdns.common.protocol import RegistryError


class RemoteRegistry:
    def __init__(self, base_url: str, token: str, timeout: float = 5.0) -> None:
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.timeout = timeout

    def load(self) -> dict:
        return self._call("GET", "/v1/admin/entries")

    def set(self, name: str, ip: str) -> None:
        self._call("PUT", self._entry(name), {"ip": ip})

    def remove(self, name: str) -> bool:
        try:
            return bool(self._call("DELETE", self._entry(name)).get("removed"))
        except _NotFound:
            return False

    @staticmethod
    def _entry(name: str) -> str:
        return "/v1/admin/entries/" + urllib.parse.quote(name, safe="")

    def _call(self, method: str, path: str, body: dict | None = None) -> dict:
        data = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(self.base_url + path, data=data, method=method)
        request.add_header("Authorization", f"Bearer {self.token}")
        if data is not None:
            request.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                return json.loads(response.read())
        except urllib.error.HTTPError as exc:
            message = _error_message(exc)
            if exc.code == 404 and method == "DELETE":
                raise _NotFound() from exc
            raise RegistryError(f"{exc.code} : {message}") from exc
        except (urllib.error.URLError, OSError) as exc:
            raise RegistryError(f"registre injoignable ({self.base_url}) : {exc}") from exc


class _NotFound(Exception):
    pass


def _error_message(exc: urllib.error.HTTPError) -> str:
    try:
        return json.loads(exc.read()).get("error", exc.reason)
    except (ValueError, AttributeError):
        return str(exc.reason)
