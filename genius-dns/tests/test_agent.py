import threading

import pytest

from geniusdns.agent import hosts
from geniusdns.agent.config import AgentConfig
from geniusdns.agent.sync import Agent
from geniusdns.common.protocol import generate_keypair
from geniusdns.registry.server import RegistryServer
from geniusdns.registry.store import RegistryStore

SUFFIX = "genius.xyz"


class Clock:
    def __init__(self):
        self.now = 1_000.0

    def __call__(self):
        return self.now


@pytest.fixture
def keys():
    return generate_keypair()


@pytest.fixture
def registry(tmp_path, keys):
    store = RegistryStore(tmp_path / "registry.json")
    server = RegistryServer(("127.0.0.1", 0), store, keys[0])
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield store, f"http://127.0.0.1:{server.server_address[1]}/v1/registry", server
    server.shutdown()
    server.server_close()


def make_agent(tmp_path, url, public, clock, grace=600.0):
    hosts_file = tmp_path / "hosts"
    if not hosts_file.exists():
        hosts_file.write_text("127.0.0.1\tlocalhost\n")
    config = AgentConfig(
        registry_url=url,
        public_key=public,
        suffixes=[SUFFIX],
        hosts_path=hosts_file,
        state_path=tmp_path / "state.json",
        grace=grace,
        timeout=1.0,
    )
    return Agent(config, clock=clock), hosts_file


def test_initial_sync_then_unchanged_then_update(tmp_path, keys, registry):
    store, url, _ = registry
    store.set(f"send.{SUFFIX}", "192.168.1.20")
    agent, hosts_file = make_agent(tmp_path, url, keys[1], Clock())

    assert agent.sync_once().status == "updated"
    assert hosts.read_entries(hosts_file) == {f"send.{SUFFIX}": "192.168.1.20"}

    assert agent.sync_once().status == "unchanged"  # 304

    store.set(f"crm.{SUFFIX}", "192.168.1.20")
    result = agent.sync_once()
    assert (result.status, result.entries) == ("updated", 2)
    store.remove(f"send.{SUFFIX}")
    agent.sync_once()
    assert hosts.read_entries(hosts_file) == {f"crm.{SUFFIX}": "192.168.1.20"}


def test_unchanged_repairs_a_tampered_hosts(tmp_path, keys, registry):
    store, url, _ = registry
    store.set(f"send.{SUFFIX}", "192.168.1.20")
    agent, hosts_file = make_agent(tmp_path, url, keys[1], Clock())
    agent.sync_once()
    hosts.remove_entries(hosts_file)
    assert agent.sync_once().status == "unchanged"
    assert hosts.read_entries(hosts_file) == {f"send.{SUFFIX}": "192.168.1.20"}


def test_state_survives_restart(tmp_path, keys, registry):
    store, url, _ = registry
    store.set(f"send.{SUFFIX}", "192.168.1.20")
    clock = Clock()
    make_agent(tmp_path, url, keys[1], clock)[0].sync_once()
    restarted, _ = make_agent(tmp_path, url, keys[1], clock)
    assert restarted.sync_once().status == "unchanged"


def test_registry_signed_with_other_key_is_rejected(tmp_path, keys, registry):
    store, url, _ = registry
    store.set(f"send.{SUFFIX}", "192.168.1.20")
    _, other_public = generate_keypair()
    agent, hosts_file = make_agent(tmp_path, url, other_public, Clock())
    assert agent.sync_once().status == "rejected"
    assert hosts.read_entries(hosts_file) == {}


def test_rollback_is_rejected(tmp_path, keys, registry):
    store, url, _ = registry
    store.set(f"a.{SUFFIX}", "192.168.1.20")
    store.set(f"b.{SUFFIX}", "192.168.1.20")
    agent, hosts_file = make_agent(tmp_path, url, keys[1], Clock())
    agent.sync_once()
    agent.state.serial = 99  # l'agent a déjà vu un serial plus récent
    agent.state.etag = None
    assert agent.sync_once().status == "rejected"
    assert len(hosts.read_entries(hosts_file)) == 2


def test_names_outside_suffix_never_reach_hosts(tmp_path, keys, registry):
    store, url, _ = registry
    store.set(f"ok.{SUFFIX}", "192.168.1.20")
    store.set("google.com", "192.168.1.66")
    store.set(f"pub.{SUFFIX}", "192.168.1.30")
    agent, hosts_file = make_agent(tmp_path, url, keys[1], Clock())
    agent.sync_once()
    assert set(hosts.read_entries(hosts_file)) == {f"ok.{SUFFIX}", f"pub.{SUFFIX}"}


def test_entries_kept_during_grace_then_removed(tmp_path, keys, registry):
    store, url, server = registry
    store.set(f"send.{SUFFIX}", "192.168.1.20")
    clock = Clock()
    agent, hosts_file = make_agent(tmp_path, url, keys[1], clock, grace=600)
    agent.sync_once()

    server.shutdown()
    server.server_close()

    clock.now += 100
    assert agent.sync_once().status == "unreachable"
    assert hosts.read_entries(hosts_file)  # encore là

    clock.now += 600
    assert agent.sync_once().status == "expired"
    assert hosts.read_entries(hosts_file) == {}
    assert (tmp_path / "hosts").read_text().startswith("127.0.0.1\tlocalhost")


def test_unreachable_at_first_start_touches_nothing(tmp_path, keys):
    agent, hosts_file = make_agent(tmp_path, "http://127.0.0.1:9/v1/registry", keys[1], Clock())
    before = hosts_file.read_text()
    assert agent.sync_once().status == "unreachable"
    assert hosts_file.read_text() == before


def test_invalid_public_key_is_refused_at_startup(tmp_path):
    with pytest.raises(ValueError, match="clé publique invalide"):
        AgentConfig(
            registry_url="http://127.0.0.1:1/v1/registry",
            public_key="registry.pub",
            suffixes=[SUFFIX],
            hosts_path=tmp_path / "hosts",
            state_path=tmp_path / "state.json",
        )


def test_cli_relative_missing_key_file(tmp_path, monkeypatch, capsys):
    from geniusdns.agent.cli import main

    monkeypatch.chdir(tmp_path)
    with pytest.raises(SystemExit) as exit_info:
        main(["--registry-url", "http://127.0.0.1:1/v1/registry", "--public-key", "registry.pub",
              "--suffix", SUFFIX, "--hosts-file", str(tmp_path / "h"), "--state-file", str(tmp_path / "s"), "sync"])
    assert "introuvable" in str(exit_info.value)
