"""Écriture du bloc géré par GeniusDNS dans le fichier hosts, sans toucher au reste."""

from __future__ import annotations

import os
import re
import shutil
import sys
import tempfile
from pathlib import Path

BEGIN = "# BEGIN GENIUSDNS (bloc géré automatiquement, ne pas modifier)"
END = "# END GENIUSDNS"

_BLOCK = re.compile(
    rf"^{re.escape(BEGIN)}[^\n]*\n.*?^{re.escape(END)}[^\n]*(?:\n|\Z)",
    re.DOTALL | re.MULTILINE,
)


class HostsError(RuntimeError):
    """Le fichier hosts ne peut pas être lu, ou son bloc est corrompu."""


def default_hosts_path() -> Path:
    if sys.platform.startswith("win"):
        root = os.environ.get("SystemRoot", r"C:\Windows")
        return Path(root) / "System32" / "drivers" / "etc" / "hosts"
    return Path("/etc/hosts")


def apply_entries(path: str | os.PathLike[str], entries: dict[str, str]) -> bool:
    """Remplace le bloc géré par `entries` (le retire si vide). True si le fichier a changé."""
    path = Path(path)
    original = _read(path)
    eol = "\r\n" if "\r\n" in original else "\n"
    updated = _strip_block(original)
    if entries:
        if updated and not updated.endswith(("\n", "\r\n")):
            updated += eol
        lines = [BEGIN, *(f"{ip}\t{name}" for name, ip in sorted(entries.items())), END]
        updated += "".join(line + eol for line in lines)
    if updated == original:
        return False
    _backup_once(path)
    _write_atomic(path, updated)
    return True


def remove_entries(path: str | os.PathLike[str]) -> bool:
    return apply_entries(path, {})


def read_entries(path: str | os.PathLike[str]) -> dict[str, str]:
    """Entrées actuellement présentes dans le bloc géré (pour `status`)."""
    text = _read(Path(path))
    match = re.search(
        rf"^{re.escape(BEGIN)}[^\n]*\n(.*?)^{re.escape(END)}", text, re.DOTALL | re.MULTILINE
    )
    entries: dict[str, str] = {}
    if match:
        for line in match.group(1).splitlines():
            parts = line.split()
            if len(parts) >= 2:
                entries[parts[1]] = parts[0]
    return entries


def _strip_block(text: str) -> str:
    begins, ends = text.count(BEGIN), text.count(END)
    if begins != ends or begins > 1:
        raise HostsError("bloc GENIUSDNS corrompu dans hosts : correction manuelle requise")
    return _BLOCK.sub("", text, count=1)


def _read(path: Path) -> str:
    try:
        with open(path, "r", encoding="utf-8", errors="surrogateescape", newline="") as handle:
            return handle.read()
    except OSError as exc:
        raise HostsError(f"lecture de {path} impossible : {exc}") from exc


def _backup_once(path: Path) -> None:
    backup = path.with_name(path.name + ".geniusdns.bak")
    if not backup.exists() and path.exists():
        try:
            shutil.copy2(path, backup)
        except OSError as exc:
            raise HostsError(f"sauvegarde de {path} impossible : {exc}") from exc


def _write_atomic(path: Path, text: str) -> None:
    tmp_name = None
    try:
        fd, tmp_name = tempfile.mkstemp(dir=path.parent, prefix=path.name + ".")
        with os.fdopen(fd, "w", encoding="utf-8", errors="surrogateescape", newline="") as handle:
            handle.write(text)
        if path.exists():
            shutil.copymode(path, tmp_name)
        else:
            os.chmod(tmp_name, 0o644)
        os.replace(tmp_name, path)
    except OSError as exc:
        if tmp_name and os.path.exists(tmp_name):
            os.unlink(tmp_name)
        raise HostsError(f"écriture de {path} impossible : {exc}") from exc
