"""Format du registre, signature Ed25519 et validation des noms / adresses."""

from __future__ import annotations

import base64
import binascii
import ipaddress
import json
import re
from typing import Any

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)

PROTOCOL_VERSION = 1

_LABEL = re.compile(r"^(?!-)[a-z0-9-]{1,63}(?<!-)$")


class RegistryError(ValueError):
    """Document de registre invalide."""


class SignatureError(RegistryError):
    """Signature absente, malformée ou ne correspondant pas à la clé publique."""


def _b64encode(raw: bytes) -> str:
    return base64.b64encode(raw).decode("ascii")


def _b64decode(value: str) -> bytes:
    try:
        return base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError, TypeError) as exc:
        raise RegistryError("base64 invalide") from exc


def canonical(payload: Any) -> bytes:
    """Sérialisation déterministe : c'est elle qui est signée."""
    return json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")


def generate_keypair() -> tuple[str, str]:
    """Retourne (clé privée, clé publique), chacune en base64 de 32 octets bruts."""
    private = Ed25519PrivateKey.generate()
    private_raw = private.private_bytes(
        serialization.Encoding.Raw,
        serialization.PrivateFormat.Raw,
        serialization.NoEncryption(),
    )
    public_raw = private.public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw
    )
    return _b64encode(private_raw), _b64encode(public_raw)


def sign(private_key_b64: str, payload: dict[str, Any]) -> dict[str, Any]:
    key = Ed25519PrivateKey.from_private_bytes(_b64decode(private_key_b64))
    return {"payload": payload, "signature": _b64encode(key.sign(canonical(payload)))}


def verify(public_key_b64: str, envelope: Any) -> dict[str, Any]:
    """Retourne le payload si la signature est valide, sinon lève SignatureError."""
    if not isinstance(envelope, dict):
        raise SignatureError("enveloppe invalide")
    payload = envelope.get("payload")
    signature = envelope.get("signature")
    if not isinstance(payload, dict) or not isinstance(signature, str):
        raise SignatureError("enveloppe incomplète")
    try:
        key = Ed25519PublicKey.from_public_bytes(_b64decode(public_key_b64))
        key.verify(_b64decode(signature), canonical(payload))
    except InvalidSignature as exc:
        raise SignatureError("signature invalide") from exc
    except RegistryError as exc:
        raise SignatureError(str(exc)) from exc
    return payload


def normalize_name(name: str) -> str:
    """Nom en minuscules, sans point final ; au moins deux labels DNS valides."""
    if not isinstance(name, str):
        raise RegistryError("nom invalide")
    cleaned = name.strip().lower().rstrip(".")
    labels = cleaned.split(".")
    if len(cleaned) > 253 or len(labels) < 2 or not all(_LABEL.match(l) for l in labels):
        raise RegistryError(f"nom de domaine invalide : {name!r}")
    return cleaned


def validate_ip(ip: str) -> str:
    """N'accepte que des adresses privées ou loopback : jamais d'IP publique."""
    try:
        address = ipaddress.ip_address(ip)
    except ValueError as exc:
        raise RegistryError(f"adresse IP invalide : {ip!r}") from exc
    if address.is_unspecified or address.is_multicast or not (
        address.is_private or address.is_loopback
    ):
        raise RegistryError(f"adresse IP non autorisée (doit être locale) : {ip}")
    return str(address)


def normalize_suffix(suffix: str) -> str:
    cleaned = normalize_name(suffix)
    return cleaned


def in_suffixes(name: str, suffixes: list[str]) -> bool:
    return any(name == s or name.endswith("." + s) for s in suffixes)


def filter_entries(
    entries: Any, suffixes: list[str]
) -> tuple[dict[str, str], list[str]]:
    """Garde les entrées valides dont le nom est sous un suffixe autorisé.

    Retourne (entrées retenues, raisons des rejets).
    """
    kept: dict[str, str] = {}
    rejected: list[str] = []
    if not isinstance(entries, dict):
        return kept, ["entries n'est pas un objet"]
    for raw_name, raw_ip in entries.items():
        try:
            name = normalize_name(raw_name)
            ip = validate_ip(raw_ip)
            if not in_suffixes(name, suffixes):
                raise RegistryError(f"{name} hors des suffixes autorisés")
        except RegistryError as exc:
            rejected.append(str(exc))
            continue
        kept[name] = ip
    return kept, rejected
