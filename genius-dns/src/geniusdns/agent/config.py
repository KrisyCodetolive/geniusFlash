"""Configuration de l'agent et état persistant entre deux synchronisations."""

from __future__ import annotations

import json
import os
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

from geniusdns.common.protocol import RegistryError, check_public_key, normalize_suffix


@dataclass
class AgentConfig:
    registry_url: str
    public_key: str
    suffixes: list[str]
    hosts_path: Path
    state_path: Path
    interval: float = 30.0
    # Au-delà de ce délai sans réponse du registre, les entrées sont retirées de hosts
    # (le PC a probablement changé de réseau : les IP privées ne seraient plus valables).
    grace: float = 600.0
    timeout: float = 5.0

    def __post_init__(self) -> None:
        if not self.suffixes:
            raise ValueError("au moins un suffixe autorisé est requis")
        try:
            check_public_key(self.public_key)
        except RegistryError as exc:
            raise ValueError(f"clé publique invalide ({exc}) : attendu 32 octets en base64, ou le chemin du fichier .pub") from exc
        self.suffixes = [normalize_suffix(s) for s in self.suffixes]
        self.hosts_path = Path(self.hosts_path)
        self.state_path = Path(self.state_path)


@dataclass
class AgentState:
    serial: int = 0
    etag: str | None = None
    last_success: float = 0.0
    entries: dict[str, str] = field(default_factory=dict)

    @classmethod
    def load(cls, path: Path) -> "AgentState":
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            return cls(
                serial=int(raw.get("serial", 0)),
                etag=raw.get("etag"),
                last_success=float(raw.get("last_success", 0.0)),
                entries=dict(raw.get("entries", {})),
            )
        except (OSError, ValueError, TypeError, AttributeError):
            return cls()

    def save(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=path.name)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(self.__dict__, handle, indent=2)
        os.replace(tmp, path)
