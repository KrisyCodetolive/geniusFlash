"""Commande `geniusdns-registry` : gérer les clés et les entrées, lancer le serveur."""

from __future__ import annotations

import argparse
import logging
import os
import sys
from pathlib import Path

from geniusdns.common.protocol import RegistryError, generate_keypair
from geniusdns.registry.server import RegistryServer
from geniusdns.registry.store import RegistryStore


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="geniusdns-registry")
    parser.add_argument("--store", default="registry.json", help="fichier du registre")
    parser.add_argument("--key-file", default="registry.key", help="clé privée de signature")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("keygen", help="génère la paire de clés (registry.key / registry.pub)")
    add = sub.add_parser("add", help="ajoute ou met à jour un nom")
    add.add_argument("name")
    add.add_argument("ip")
    remove = sub.add_parser("remove", help="supprime un nom")
    remove.add_argument("name")
    sub.add_parser("list", help="liste les entrées")
    serve = sub.add_parser("serve", help="lance le serveur du registre")
    serve.add_argument("--host", default="0.0.0.0")
    serve.add_argument("--port", type=int, default=5353)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    store = RegistryStore(args.store)
    key_path = Path(args.key_file)

    try:
        if args.command == "keygen":
            return _keygen(key_path)
        if args.command == "add":
            store.set(args.name, args.ip)
            print(f"{args.name} -> {args.ip}")
        elif args.command == "remove":
            print("supprimé" if store.remove(args.name) else "introuvable")
        elif args.command == "list":
            data = store.load()
            print(f"serial {data['serial']}")
            for name, ip in sorted(data["entries"].items()):
                print(f"{ip:<16} {name}")
        elif args.command == "serve":
            return _serve(store, key_path, args.host, args.port)
    except RegistryError as exc:
        print(f"erreur : {exc}", file=sys.stderr)
        return 2
    return 0


def _keygen(key_path: Path) -> int:
    pub_path = key_path.with_suffix(".pub")
    if key_path.exists():
        print(f"{key_path} existe déjà, rien n'a été écrasé", file=sys.stderr)
        return 1
    private, public = generate_keypair()
    fd = os.open(key_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as handle:
        handle.write(private + "\n")
    pub_path.write_text(public + "\n", encoding="utf-8")
    print(f"clé privée : {key_path} (à garder secrète)")
    print(f"clé publique : {pub_path}\n{public}")
    return 0


def _serve(store: RegistryStore, key_path: Path, host: str, port: int) -> int:
    if not key_path.exists():
        print(f"clé introuvable : {key_path} (lancez d'abord `keygen`)", file=sys.stderr)
        return 1
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    server = RegistryServer((host, port), store, key_path.read_text().strip())
    logging.getLogger("geniusdns.registry").info("écoute sur %s:%d", host, port)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
