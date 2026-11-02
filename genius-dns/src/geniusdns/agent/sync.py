"""Cycle de synchronisation : interroger le registre, vérifier, écrire hosts."""

from __future__ import annotations

import json
import logging
import threading
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass

from geniusdns.agent import hosts
from geniusdns.agent.config import AgentConfig, AgentState
from geniusdns.common.protocol import PROTOCOL_VERSION, RegistryError, filter_entries, verify

log = logging.getLogger("geniusdns.agent")


@dataclass
class SyncResult:
    status: str  # updated | unchanged | rejected | unreachable | expired
    detail: str = ""
    entries: int = 0


class Agent:
    def __init__(self, config: AgentConfig, clock: Callable[[], float] = time.time) -> None:
        self.config = config
        self.clock = clock
        self.state = AgentState.load(config.state_path)

    def sync_once(self) -> SyncResult:
        try:
            result = self._sync()
        except hosts.HostsError as exc:
            log.error("hosts : %s", exc)
            return SyncResult("rejected", str(exc))
        log.info("sync : %s %s", result.status, result.detail)
        return result

    def _sync(self) -> SyncResult:
        try:
            envelope, etag = self._fetch()
        except (urllib.error.URLError, OSError, ValueError) as exc:
            return self._on_failure("unreachable", str(exc))

        if envelope is None:  # 304 : rien de nouveau, le registre est joignable
            self.state.last_success = self.clock()
            hosts.apply_entries(self.config.hosts_path, self.state.entries)  # répare un hosts modifié
            self.state.save(self.config.state_path)
            return SyncResult("unchanged", entries=len(self.state.entries))

        try:
            payload = verify(self.config.public_key, envelope)
            if payload.get("version") != PROTOCOL_VERSION:
                raise RegistryError(f"version de protocole inconnue : {payload.get('version')}")
            serial = payload.get("serial")
            if not isinstance(serial, int) or serial < self.state.serial:
                raise RegistryError(f"serial {serial!r} < {self.state.serial} (retour en arrière)")
        except RegistryError as exc:
            log.warning("registre refusé : %s", exc)
            return self._on_failure("rejected", str(exc))

        entries, rejected = filter_entries(payload.get("entries"), self.config.suffixes)
        for reason in rejected:
            log.warning("entrée ignorée : %s", reason)

        hosts.apply_entries(self.config.hosts_path, entries)
        self.state.serial = serial
        self.state.etag = etag
        self.state.entries = entries
        self.state.last_success = self.clock()
        self.state.save(self.config.state_path)
        return SyncResult("updated", f"serial {serial}", len(entries))

    def _on_failure(self, status: str, reason: str) -> SyncResult:
        """Registre injoignable ou refusé : on garde les entrées le temps de la grâce, puis on les retire."""
        age = self.clock() - self.state.last_success
        if self.state.entries and age > self.config.grace:
            hosts.remove_entries(self.config.hosts_path)
            self.state.entries = {}
            self.state.etag = None  # forcera un téléchargement complet au retour du registre
            self.state.save(self.config.state_path)
            return SyncResult("expired", f"registre {'refusé' if status == 'rejected' else 'injoignable'} depuis {int(age)} s : {reason}")
        return SyncResult(status, reason, len(self.state.entries))

    def _fetch(self) -> tuple[dict | None, str | None]:
        request = urllib.request.Request(self.config.registry_url)
        if self.state.etag:
            request.add_header("If-None-Match", self.state.etag)
        try:
            with urllib.request.urlopen(request, timeout=self.config.timeout) as response:
                return json.loads(response.read(1_000_000)), response.headers.get("ETag")
        except urllib.error.HTTPError as exc:
            if exc.code == 304:
                return None, None
            raise

    def run_forever(self, stop: threading.Event) -> None:
        log.info("agent démarré, registre %s", self.config.registry_url)
        while not stop.is_set():
            self.sync_once()
            stop.wait(self.config.interval)
        log.info("agent arrêté (les entrées hosts sont conservées)")
