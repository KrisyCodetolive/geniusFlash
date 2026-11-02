"""Commande `geniusdns-agent` : run, sync, status, clean."""

from __future__ import annotations

import argparse
import json
import logging
import os
import signal
import sys
import threading
from pathlib import Path

from geniusdns.agent import hosts
from geniusdns.agent.config import AgentConfig, AgentState
from geniusdns.agent.sync import Agent
from geniusdns.common.protocol import RegistryError


def default_state_path() -> Path:
    if sys.platform.startswith("win"):
        return Path(os.environ.get("ProgramData", r"C:\ProgramData")) / "GeniusDNS" / "state.json"
    return Path("/var/lib/geniusdns/state.json")


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="geniusdns-agent")
    parser.add_argument("--config", help="fichier JSON ; les options de la ligne de commande priment")
    parser.add_argument("--registry-url", help="ex. http://192.168.1.20:5353/v1/registry")
    parser.add_argument("--public-key", help="clé publique du registre (base64) ou chemin du fichier .pub")
    parser.add_argument("--suffix", action="append", dest="suffixes", help="suffixe autorisé (répétable)")
    parser.add_argument("--hosts-file", default=str(hosts.default_hosts_path()))
    parser.add_argument("--state-file", default=str(default_state_path()))
    parser.add_argument("--interval", type=float, default=30.0, help="secondes entre deux synchronisations")
    parser.add_argument("--grace", type=float, default=600.0, help="secondes avant retrait si registre injoignable")
    parser.add_argument("-v", "--verbose", action="store_true")
    parser.add_argument("command", choices=["run", "sync", "status", "clean"])
    return parser


def _load_config(parser: argparse.ArgumentParser, argv: list[str] | None) -> tuple[argparse.Namespace, dict]:
    args = parser.parse_args(argv)
    file_values: dict = {}
    if args.config:
        file_values = json.loads(Path(args.config).read_text(encoding="utf-8"))
        # les valeurs du fichier remplacent les défauts, la ligne de commande les remplace à son tour
        parser.set_defaults(**{k.replace("-", "_"): v for k, v in file_values.items()})
        args = parser.parse_args(argv)
    return args, file_values


def _make_config(args: argparse.Namespace) -> AgentConfig:
    missing = [n for n in ("registry_url", "public_key", "suffixes") if not getattr(args, n)]
    if missing:
        raise SystemExit("options manquantes : " + ", ".join(m.replace("_", "-") for m in missing))
    key = args.public_key
    if os.path.isfile(key):
        key = Path(key).read_text(encoding="utf-8").strip()
    elif os.sep in key or key.endswith(".pub"):
        # Un chemin relatif est résolu depuis le dossier courant, pas depuis celui de l'exécutable.
        raise SystemExit(f"clé publique introuvable : {key} (dossier courant : {os.getcwd()}). Utilisez un chemin absolu.")
    return AgentConfig(
        registry_url=args.registry_url,
        public_key=key,
        suffixes=args.suffixes if isinstance(args.suffixes, list) else [args.suffixes],
        hosts_path=Path(args.hosts_file),
        state_path=Path(args.state_file),
        interval=args.interval,
        grace=args.grace,
    )


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args, _ = _load_config(parser, argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )

    try:
        if args.command == "clean":
            changed = hosts.remove_entries(args.hosts_file)
            state_path = Path(args.state_file)
            AgentState().save(state_path)
            print("bloc GeniusDNS retiré de hosts" if changed else "aucun bloc à retirer")
            return 0

        if args.command == "status":
            state = AgentState.load(Path(args.state_file))
            print(f"serial {state.serial}, entrées dans l'état : {len(state.entries)}")
            for name, ip in sorted(hosts.read_entries(args.hosts_file).items()):
                print(f"{ip:<16} {name}")
            return 0

        agent = Agent(_make_config(args))
        if args.command == "sync":
            result = agent.sync_once()
            print(f"{result.status} {result.detail} ({result.entries} entrées)")
            return 0 if result.status in ("updated", "unchanged") else 1

        stop = threading.Event()
        for sig in (signal.SIGINT, signal.SIGTERM):
            signal.signal(sig, lambda *_: stop.set())
        agent.run_forever(stop)
        return 0
    except (hosts.HostsError, RegistryError, ValueError) as exc:
        print(f"erreur : {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
