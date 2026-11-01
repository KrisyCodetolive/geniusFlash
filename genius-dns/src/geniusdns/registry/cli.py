"""Commande `geniusdns-registry` (alias `gdns`) : gérer les entrées, les clés, lancer le serveur.

Sans --server, les commandes add/remove/list agissent directement sur le fichier du registre.
Avec --server (ou GENIUSDNS_SERVER), elles passent par l'API du serveur en cours d'exécution,
authentifiée par un jeton (--token-file ou GENIUSDNS_TOKEN).
"""

from __future__ import annotations

import argparse
import logging
import os
import secrets
import sys
from pathlib import Path

from geniusdns.common.protocol import RegistryError, generate_keypair
from geniusdns.registry.remote import RemoteRegistry
from geniusdns.registry.server import RegistryServer
from geniusdns.registry.store import RegistryStore


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="geniusdns-registry")
    parser.add_argument("--store", default="registry.json", help="fichier du registre (mode local)")
    parser.add_argument("--key-file", default="registry.key", help="clé privée de signature")
    parser.add_argument("--token-file", default="registry.token", help="jeton d'administration")
    parser.add_argument(
        "--server",
        default=os.environ.get("GENIUSDNS_SERVER"),
        help="ex. http://172.20.10.2:5353 : agir via le serveur au lieu du fichier local",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("keygen", help="génère la paire de clés (registry.key / registry.pub)")
    sub.add_parser("token", help="génère le jeton d'administration (registry.token)")
    add = sub.add_parser("add", help="ajoute ou met à jour un nom")
    add.add_argument("name")
    add.add_argument("ip")
    remove = sub.add_parser("remove", help="supprime un nom")
    remove.add_argument("name")
    sub.add_parser("list", help="liste les entrées")
    serve = sub.add_parser("serve", help="lance le serveur du registre")
    serve.add_argument("--host", default="0.0.0.0")
    serve.add_argument("--port", type=int, default=5353)
    serve.add_argument("--downloads-dir", default="dist", help="dossier servi sur /download/")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    try:
        if args.command == "keygen":
            return _keygen(Path(args.key_file))
        if args.command == "token":
            return _token(Path(args.token_file))
        if args.command == "serve":
            return _serve(args)

        registry = _open_registry(args)
        if args.command == "add":
            registry.set(args.name, args.ip)
            print(f"{args.name} -> {args.ip}")
        elif args.command == "remove":
            print("supprimé" if registry.remove(args.name) else "introuvable")
        elif args.command == "list":
            data = registry.load()
            print(f"serial {data['serial']}")
            for name, ip in sorted(data["entries"].items()):
                print(f"{ip:<16} {name}")
    except RegistryError as exc:
        print(f"erreur : {exc}", file=sys.stderr)
        return 2
    return 0


def _open_registry(args: argparse.Namespace) -> RegistryStore | RemoteRegistry:
    if not args.server:
        return RegistryStore(args.store)
    token = os.environ.get("GENIUSDNS_TOKEN") or _read_secret(Path(args.token_file))
    if not token:
        raise RegistryError(f"jeton introuvable : {args.token_file} (ou variable GENIUSDNS_TOKEN)")
    return RemoteRegistry(args.server, token)


def _read_secret(path: Path) -> str | None:
    try:
        return path.read_text(encoding="utf-8").strip() or None
    except OSError:
        return None


def _write_secret(path: Path, value: str) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as handle:
        handle.write(value + "\n")


def _keygen(key_path: Path) -> int:
    pub_path = key_path.with_suffix(".pub")
    if key_path.exists():
        print(f"{key_path} existe déjà, rien n'a été écrasé", file=sys.stderr)
        return 1
    private, public = generate_keypair()
    _write_secret(key_path, private)
    pub_path.write_text(public + "\n", encoding="utf-8")
    print(f"clé privée : {key_path} (à garder secrète, ne jamais commiter)")
    print(f"clé publique : {pub_path}\n{public}")
    return 0


def _token(token_path: Path) -> int:
    if token_path.exists():
        print(f"{token_path} existe déjà, rien n'a été écrasé", file=sys.stderr)
        return 1
    _write_secret(token_path, secrets.token_urlsafe(32))
    print(f"jeton d'administration : {token_path} (à copier sur les machines qui administrent le registre)")
    return 0


def _serve(args: argparse.Namespace) -> int:
    key_path = Path(args.key_file)
    if not key_path.exists():
        print(f"clé introuvable : {key_path} (lancez d'abord `keygen`)", file=sys.stderr)
        return 1
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    log = logging.getLogger("geniusdns.registry")
    token = _read_secret(Path(args.token_file))
    if token:
        log.info("administration à distance activée (%s)", args.token_file)
    else:
        log.info("pas de %s : administration à distance désactivée (voir `token`)", args.token_file)
    server = RegistryServer(
        (args.host, args.port),
        RegistryStore(args.store),
        key_path.read_text().strip(),
        admin_token=token,
        downloads_dir=args.downloads_dir,
    )
    log.info("écoute sur %s:%d, téléchargements : %s", args.host, args.port, args.downloads_dir)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
