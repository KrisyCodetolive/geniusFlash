import threading
import urllib.error
import urllib.request

import pytest

from geniusdns.common.protocol import generate_keypair
from geniusdns.registry.cli import main
from geniusdns.registry.server import RegistryServer
from geniusdns.registry.store import RegistryStore

TOKEN = "s3cret-token"


@pytest.fixture
def served(tmp_path):
    downloads = tmp_path / "dist"
    downloads.mkdir()
    (downloads / "geniusdns-agent-linux").write_bytes(b"\x7fELF-fake")
    (tmp_path / "secret.txt").write_text("nope")
    store = RegistryStore(tmp_path / "registry.json")
    server = RegistryServer(("127.0.0.1", 0), store, generate_keypair()[0], TOKEN, downloads)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_address[1]}", store, tmp_path
    server.shutdown()
    server.server_close()


def cli(url, tmp_path, *args, token=TOKEN, monkeypatch=None):
    (tmp_path / "t.token").write_text(token + "\n")
    return main(["--server", url, "--token-file", str(tmp_path / "t.token"), *args])


def test_remote_add_list_remove(served, capsys):
    url, store, tmp = served
    assert cli(url, tmp, "add", "send.genius.ln", "172.20.10.2") == 0
    assert store.load()["entries"] == {"send.genius.ln": "172.20.10.2"}
    capsys.readouterr()
    assert cli(url, tmp, "list") == 0
    assert "172.20.10.2" in capsys.readouterr().out
    assert cli(url, tmp, "remove", "send.genius.ln") == 0
    assert "supprimé" in capsys.readouterr().out
    assert cli(url, tmp, "remove", "send.genius.ln") == 0
    assert "introuvable" in capsys.readouterr().out


def test_remote_rejects_bad_token_and_bad_input(served, capsys):
    url, store, tmp = served
    assert cli(url, tmp, "add", "a.genius.ln", "10.0.0.1", token="wrong") == 2
    assert "401" in capsys.readouterr().err
    assert cli(url, tmp, "add", "a.genius.ln", "8.8.8.8") == 2  # IP publique refusée
    assert "400" in capsys.readouterr().err
    assert store.load()["entries"] == {}


def test_admin_disabled_without_token(tmp_path):
    server = RegistryServer(("127.0.0.1", 0), RegistryStore(tmp_path / "r.json"), generate_keypair()[0])
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        url = f"http://127.0.0.1:{server.server_address[1]}/v1/admin/entries"
        with pytest.raises(urllib.error.HTTPError) as err:
            urllib.request.urlopen(urllib.request.Request(url, headers={"Authorization": "Bearer "}))
        assert err.value.code == 404
    finally:
        server.shutdown()
        server.server_close()


def test_download_listing_and_file(served):
    url, _, _ = served
    assert urllib.request.urlopen(url + "/download/").read() == b"geniusdns-agent-linux\n"
    assert urllib.request.urlopen(url + "/download/geniusdns-agent-linux").read() == b"\x7fELF-fake"


@pytest.mark.parametrize("path", ["/download/../secret.txt", "/download/%2e%2e%2fsecret.txt", "/download/nope"])
def test_download_refuses_traversal_and_unknown(served, path):
    url, _, _ = served
    with pytest.raises(urllib.error.HTTPError) as err:
        urllib.request.urlopen(url + path)
    assert err.value.code == 404


def test_token_command_does_not_overwrite(tmp_path, capsys):
    path = tmp_path / "registry.token"
    assert main(["--token-file", str(path), "token"]) == 0
    first = path.read_text()
    assert oct(path.stat().st_mode & 0o777) == "0o600"
    assert main(["--token-file", str(path), "token"]) == 1
    assert path.read_text() == first
