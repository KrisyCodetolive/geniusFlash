import pytest

from geniusdns.common.protocol import (
    RegistryError,
    SignatureError,
    filter_entries,
    generate_keypair,
    normalize_name,
    sign,
    validate_ip,
    verify,
)


def test_sign_verify_roundtrip():
    private, public = generate_keypair()
    envelope = sign(private, {"serial": 1, "entries": {"a.test.xyz": "192.168.1.2"}})
    assert verify(public, envelope)["serial"] == 1


def test_tampered_payload_is_rejected():
    private, public = generate_keypair()
    envelope = sign(private, {"serial": 1, "entries": {"a.test.xyz": "192.168.1.2"}})
    envelope["payload"]["entries"]["a.test.xyz"] = "192.168.1.99"
    with pytest.raises(SignatureError):
        verify(public, envelope)


def test_wrong_key_is_rejected():
    private, _ = generate_keypair()
    _, other_public = generate_keypair()
    with pytest.raises(SignatureError):
        verify(other_public, sign(private, {"serial": 1}))


@pytest.mark.parametrize("bad", [None, {}, {"payload": {}}, {"payload": {}, "signature": "!!"}])
def test_malformed_envelope_is_rejected(bad):
    _, public = generate_keypair()
    with pytest.raises(SignatureError):
        verify(public, bad)


def test_normalize_name():
    assert normalize_name(" App.Genius.XYZ. ") == "app.genius.xyz"
    for bad in ["localhost", "-a.xyz", "a..xyz", "a_b.xyz", "a b.xyz", ""]:
        with pytest.raises(RegistryError):
            normalize_name(bad)


def test_validate_ip_only_local():
    assert validate_ip("192.168.1.20") == "192.168.1.20"
    assert validate_ip("127.0.0.1") == "127.0.0.1"
    for bad in ["8.8.8.8", "0.0.0.0", "224.0.0.1", "nope", "142.250.0.1"]:
        with pytest.raises(RegistryError):
            validate_ip(bad)


def test_filter_entries_enforces_suffix_and_ip():
    kept, rejected = filter_entries(
        {
            "send.genius.xyz": "192.168.1.20",
            "genius.xyz": "192.168.1.20",
            "evilgenius.xyz": "192.168.1.20",
            "google.com": "192.168.1.66",
            "pub.genius.xyz": "8.8.8.8",
        },
        ["genius.xyz"],
    )
    assert kept == {"send.genius.xyz": "192.168.1.20", "genius.xyz": "192.168.1.20"}
    assert len(rejected) == 3
