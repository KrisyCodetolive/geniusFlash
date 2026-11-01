"""Stockage du registre : un fichier JSON {serial, entries}."""

from __future__ import annotations

import json
import os
import tempfile
import threading
from pathlib import Path

from geniusdns.common.protocol import normalize_name, validate_ip


class RegistryStore:
    def __init__(self, path: str | os.PathLike[str]) -> None:
        self.path = Path(path)
        self._lock = threading.Lock()

    def load(self) -> dict:
        with self._lock:
            return self._read()

    def set(self, name: str, ip: str) -> None:
        name, ip = normalize_name(name), validate_ip(ip)
        with self._lock:
            data = self._read()
            if data["entries"].get(name) == ip:
                return
            data["entries"][name] = ip
            self._write(data)

    def remove(self, name: str) -> bool:
        name = normalize_name(name)
        with self._lock:
            data = self._read()
            if name not in data["entries"]:
                return False
            del data["entries"][name]
            self._write(data)
            return True

    def _read(self) -> dict:
        if not self.path.exists():
            return {"serial": 0, "entries": {}}
        return json.loads(self.path.read_text(encoding="utf-8"))

    def _write(self, data: dict) -> None:
        # Le serial augmente à chaque modification : l'agent s'en sert comme version
        # (ETag) et pour refuser un retour en arrière.
        data["serial"] += 1
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=self.path.parent, prefix=self.path.name)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(data, handle, indent=2, sort_keys=True)
        os.replace(tmp, self.path)
