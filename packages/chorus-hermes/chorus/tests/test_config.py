import os

import pytest

from chorus_hermes import config as c


def test_load_config_from_env():
    cfg = c.load_config({"CHORUS_URL": " https://x.test/ ", "CHORUS_API_KEY": "k",
                         "CHORUS_ALLOWED_USERS": "a, b,,"})
    assert cfg.url == "https://x.test"
    assert cfg.mcp_url == "https://x.test/api/mcp"
    assert cfg.allowed_users == ("a", "b")


def test_load_config_strips_mcp_suffix():
    assert c.load_config({"CHORUS_URL": "https://x.test/api/mcp", "CHORUS_API_KEY": "k"}).url == "https://x.test"


@pytest.mark.parametrize("env,missing", [
    ({}, "CHORUS_URL, CHORUS_API_KEY"),
    ({"CHORUS_URL": "https://x.test"}, "CHORUS_API_KEY"),
    ({"CHORUS_API_KEY": "k", "CHORUS_URL": "  "}, "CHORUS_URL"),
])
def test_load_config_missing(env, missing):
    with pytest.raises(c.ConfigError, match=missing):
        c.load_config(env)
    assert c.is_configured(env) is False


def test_rejects_non_http_url():
    with pytest.raises(c.ConfigError):
        c.load_config({"CHORUS_URL": "${CHORUS_URL}", "CHORUS_API_KEY": "k"})


def test_repr_redacts_key():
    cfg = c.ChorusConfig(url="https://x.test", api_key="supersecret")
    assert "supersecret" not in repr(cfg)
    assert "redacted" in repr(cfg)


def test_is_configured_true():
    assert c.is_configured({"CHORUS_URL": "https://x", "CHORUS_API_KEY": "k"})


def test_terminal_cwd_resolves_realpath(tmp_path):
    real = tmp_path / "repo"
    real.mkdir()
    link = tmp_path / "link"
    link.symlink_to(real)
    assert c.terminal_cwd({"terminal": {"cwd": str(link)}}) == os.path.realpath(real)


def test_terminal_cwd_expands_user(monkeypatch, tmp_path):
    monkeypatch.setenv("HOME", str(tmp_path))
    (tmp_path / "proj").mkdir()
    assert c.terminal_cwd({"terminal": {"cwd": "~/proj"}}) == os.path.realpath(tmp_path / "proj")


@pytest.mark.parametrize("cfg", [
    {}, {"terminal": None}, {"terminal": {}}, {"terminal": {"cwd": None}}, {"terminal": {"cwd": 3}},
    {"terminal": {"cwd": ""}}, {"terminal": {"cwd": "."}}, {"terminal": {"cwd": "auto"}},
    {"terminal": {"cwd": "cwd"}}, {"terminal": {"cwd": "/definitely/not/here"}}, "nonsense",
])
def test_terminal_cwd_unknown(cfg):
    assert c.terminal_cwd(cfg) is None


def test_terminal_cwd_uses_loader(tmp_path):
    assert c.terminal_cwd(loader=lambda: {"terminal": {"cwd": str(tmp_path)}}) == os.path.realpath(tmp_path)


def test_load_hermes_config_falls_back_to_yaml(tmp_path, monkeypatch):
    import sys
    monkeypatch.setitem(sys.modules, "hermes_cli", None)  # force ImportError of Hermes
    (tmp_path / "config.yaml").write_text("terminal:\n  cwd: /srv/repo\n")
    assert c.load_hermes_config({"HERMES_HOME": str(tmp_path)}) == {"terminal": {"cwd": "/srv/repo"}}


def test_load_hermes_config_missing_or_bad(tmp_path, monkeypatch):
    import sys
    monkeypatch.setitem(sys.modules, "hermes_cli", None)
    assert c.load_hermes_config({"HERMES_HOME": str(tmp_path)}) == {}
    (tmp_path / "config.yaml").write_text("- a list\n")
    assert c.load_hermes_config({"HERMES_HOME": str(tmp_path)}) == {}


def test_load_hermes_config_prefers_hermes_loader(monkeypatch):
    import sys
    import types
    mod = types.ModuleType("hermes_cli.config")
    mod.load_config_readonly = lambda: {"terminal": {"cwd": "/from/hermes"}}
    pkg = types.ModuleType("hermes_cli")
    pkg.config = mod
    monkeypatch.setitem(sys.modules, "hermes_cli", pkg)
    monkeypatch.setitem(sys.modules, "hermes_cli.config", mod)
    assert c.load_hermes_config() == {"terminal": {"cwd": "/from/hermes"}}


def test_hermes_home_default(monkeypatch, tmp_path):
    monkeypatch.setenv("HOME", str(tmp_path))
    assert c.hermes_home({}) == tmp_path / ".hermes"
