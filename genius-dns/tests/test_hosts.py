import pytest

from geniusdns.agent import hosts

BASE = "127.0.0.1\tlocalhost\n::1\tlocalhost\n"


def test_apply_preserves_existing_content_and_is_idempotent(tmp_path):
    f = tmp_path / "hosts"
    f.write_text(BASE)
    assert hosts.apply_entries(f, {"a.genius.xyz": "192.168.1.20"}) is True
    text = f.read_text()
    assert text.startswith(BASE)
    assert "192.168.1.20\ta.genius.xyz" in text
    assert hosts.apply_entries(f, {"a.genius.xyz": "192.168.1.20"}) is False
    assert (tmp_path / "hosts.geniusdns.bak").read_text() == BASE


def test_update_replaces_block(tmp_path):
    f = tmp_path / "hosts"
    f.write_text(BASE)
    hosts.apply_entries(f, {"a.genius.xyz": "192.168.1.20", "b.genius.xyz": "192.168.1.20"})
    hosts.apply_entries(f, {"c.genius.xyz": "192.168.1.21"})
    assert hosts.read_entries(f) == {"c.genius.xyz": "192.168.1.21"}
    assert f.read_text().count(hosts.BEGIN) == 1


def test_remove_restores_original(tmp_path):
    f = tmp_path / "hosts"
    f.write_text(BASE)
    hosts.apply_entries(f, {"a.genius.xyz": "192.168.1.20"})
    assert hosts.remove_entries(f) is True
    assert f.read_text() == BASE
    assert hosts.remove_entries(f) is False


def test_no_trailing_newline_and_crlf(tmp_path):
    f = tmp_path / "hosts"
    f.write_bytes(b"127.0.0.1 localhost\r\n10.0.0.1 x")
    hosts.apply_entries(f, {"a.genius.xyz": "192.168.1.20"})
    data = f.read_bytes()
    assert b"10.0.0.1 x\r\n" + hosts.BEGIN.encode() in data
    assert b"\n" not in data.replace(b"\r\n", b"")
    hosts.remove_entries(f)
    assert f.read_bytes() == b"127.0.0.1 localhost\r\n10.0.0.1 x\r\n"


def test_corrupted_block_is_refused(tmp_path):
    f = tmp_path / "hosts"
    f.write_text(BASE + hosts.BEGIN + "\n1.1.1.1\tx\n")
    with pytest.raises(hosts.HostsError):
        hosts.apply_entries(f, {"a.genius.xyz": "192.168.1.20"})
    assert "1.1.1.1" in f.read_text()


def test_missing_file_raises(tmp_path):
    with pytest.raises(hosts.HostsError):
        hosts.apply_entries(tmp_path / "absent", {"a.genius.xyz": "192.168.1.20"})
