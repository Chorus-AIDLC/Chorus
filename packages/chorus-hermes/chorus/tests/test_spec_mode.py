import os

import pytest

from chorus_hermes.spec_mode import resolve_spec_mode


@pytest.fixture
def repo(tmp_path):
    (tmp_path / "openspec").mkdir()
    return tmp_path


def has_cli(_name):
    return "/usr/bin/openspec"


def no_cli(_name):
    return None


def test_default_openspec_when_dir_and_cli(repo):
    r = resolve_spec_mode(str(repo), {}, which=has_cli)
    assert r.mode == "openspec" and not r.fail and r.openspec_active
    assert r.reason.startswith("default — openspec/ directory + openspec CLI both present")


def test_default_lite_without_dir(tmp_path):
    r = resolve_spec_mode(str(tmp_path), {}, which=has_cli)
    assert r.mode == "lite" and not r.fail and not r.openspec_active
    assert "no openspec/ directory" in r.reason
    assert r.hint == "npm i -g @fission-ai/openspec && openspec init"


def test_default_lite_without_cli(repo):
    r = resolve_spec_mode(str(repo), {}, which=no_cli)
    assert r.mode == "lite" and not r.fail
    assert "CLI not on PATH" in r.reason
    assert r.hint == "npm i -g @fission-ai/openspec"


@pytest.mark.parametrize("mode", ["lite", "off"])
def test_explicit_wins_over_usable_openspec(repo, mode):
    r = resolve_spec_mode(str(repo), {"CHORUS_SPEC_MODE": mode}, which=has_cli)
    assert r.mode == mode and r.reason.startswith("explicit") and not r.fail
    assert r.openspec_usable  # still reported, but not chosen


def test_explicit_openspec_usable(repo):
    r = resolve_spec_mode(str(repo), {"CHORUS_SPEC_MODE": "openspec"}, which=has_cli)
    assert r.mode == "openspec" and not r.fail and r.reason.startswith("explicit;")


def test_explicit_openspec_not_installed_sets_fail(tmp_path):
    r = resolve_spec_mode(str(tmp_path), {"CHORUS_SPEC_MODE": "openspec"}, which=no_cli)
    assert r.mode == "openspec" and r.fail.startswith("OpenSpec not usable (")
    assert not r.openspec_active


def test_explicit_openspec_missing_cli_sets_fail(repo):
    r = resolve_spec_mode(str(repo), {"CHORUS_SPEC_MODE": "openspec"}, which=no_cli)
    assert r.fail == "OpenSpec not usable (openspec/ directory present but `openspec` CLI not on PATH)"


@pytest.mark.parametrize("env,why", [
    ({"CHORUS_OPENSPEC_MODE": "off"}, "CHORUS_OPENSPEC_MODE=off (legacy opt-out)"),
    ({"CHORUS_ENABLE_OPENSPEC": "false"}, "CHORUS_ENABLE_OPENSPEC=false (plugin-level opt-out)"),
])
def test_disabled_openspec(repo, env, why):
    r = resolve_spec_mode(str(repo), env, which=has_cli)
    assert r.mode == "lite" and not r.openspec_usable and why in r.reason
    r2 = resolve_spec_mode(str(repo), {**env, "CHORUS_SPEC_MODE": "openspec"}, which=has_cli)
    assert r2.mode == "openspec" and r2.fail.startswith("config conflict — CHORUS_SPEC_MODE=openspec vs OpenSpec disabled")
    assert r2.hint == ""


def test_unrecognized_value_falls_back(repo, tmp_path_factory):
    r = resolve_spec_mode(str(repo), {"CHORUS_SPEC_MODE": "bogus"}, which=has_cli)
    assert r.mode == "openspec" and "unrecognized" in r.reason and not r.fail
    empty = tmp_path_factory.mktemp("empty")
    r2 = resolve_spec_mode(str(empty), {"CHORUS_SPEC_MODE": "bogus"}, which=has_cli)
    assert r2.mode == "lite" and "unrecognized" in r2.reason


def test_defaults_to_cwd_and_process_env(repo, monkeypatch):
    monkeypatch.chdir(repo)
    monkeypatch.setenv("CHORUS_SPEC_MODE", "off")
    assert resolve_spec_mode(which=has_cli).mode == "off"
    assert os.path.isdir(repo / "openspec")


# --- parity with the Codex shell resolver -------------------------------------

import shutil  # noqa: E402
import subprocess  # noqa: E402

from tests.conftest import REPO_ROOT  # noqa: E402

RESOLVER = REPO_ROOT / "plugins" / "chorus" / "hooks" / "resolve-spec-mode.sh"


@pytest.mark.skipif(not shutil.which("bash") or not RESOLVER.is_file(), reason="needs bash + Codex resolver")
@pytest.mark.parametrize("explicit", [None, "lite", "off", "openspec", "bogus"])
@pytest.mark.parametrize("with_dir", [True, False])
@pytest.mark.parametrize("with_cli", [True, False])
@pytest.mark.parametrize("legacy_off", [False, True])
def test_matches_shell_resolver(tmp_path, explicit, with_dir, with_cli, legacy_off):
    root = tmp_path / "repo"
    root.mkdir()
    if with_dir:
        (root / "openspec").mkdir()
    bindir = tmp_path / "bin"
    bindir.mkdir()
    if with_cli:
        exe = bindir / "openspec"
        exe.write_text("#!/bin/sh\nexit 0\n")
        exe.chmod(0o755)
    env = {}
    if explicit is not None:
        env["CHORUS_SPEC_MODE"] = explicit
    if legacy_off:
        env["CHORUS_OPENSPEC_MODE"] = "off"
    bash = shutil.which("bash")
    script = f'. "{RESOLVER}"; printf "%s\\n%s\\n%s\\n%s" "$SPEC_MODE" "$SPEC_FAIL" "$SPEC_REASON" "$CHORUS_OPENSPEC_ACTIVE"'
    out = subprocess.run([bash, "-c", script], capture_output=True, text=True, check=True,
                         env={**env, "PATH": str(bindir), "PROJECT_ROOT": str(root)}).stdout.split("\n")
    py = resolve_spec_mode(str(root), env, which=lambda n: shutil.which(n, path=str(bindir)))
    assert [py.mode, py.fail, py.reason, "1" if py.openspec_active else "0"] == out
