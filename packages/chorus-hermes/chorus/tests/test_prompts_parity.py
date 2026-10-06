"""Prompt parity: ``chorus_hermes.prompts`` must render byte-identical output to
``cli/prompts.mjs`` for the shared fixture set (every WAKE_ACTIONS action plus
edge cases). ``node`` renders the fixtures; pytest compares."""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from chorus_hermes import prompts

from .conftest import REPO_ROOT

FIXTURES = Path(__file__).parent / "fixtures" / "prompt_fixtures.json"
RENDERER = Path(__file__).parent / "fixtures" / "render_prompts.mjs"
CLI_PROMPTS = REPO_ROOT / "cli" / "prompts.mjs"

NODE = shutil.which("node")
pytestmark = pytest.mark.skipif(
    NODE is None or not CLI_PROMPTS.is_file(),
    reason="prompt parity needs node and the Chorus repo's cli/prompts.mjs",
)


def _render(fn):
    try:
        return {"ok": fn()}
    except Exception as exc:  # mirror the node side: record the error message
        return {"error": str(exc)}


@pytest.fixture(scope="module")
def node_output():
    proc = subprocess.run([NODE, str(RENDERER), str(REPO_ROOT), str(FIXTURES)],
                          capture_output=True, check=True, timeout=60)
    return json.loads(proc.stdout.decode("utf-8"))


@pytest.fixture(scope="module")
def fixtures():
    return json.loads(FIXTURES.read_text(encoding="utf-8"))


def test_wake_actions_match(node_output):
    assert sorted(prompts.WAKE_ACTIONS) == node_output["wakeActions"]


def test_fixtures_cover_every_wake_action(fixtures):
    covered = {f["notification"].get("action") for f in fixtures["single"]}
    assert prompts.WAKE_ACTIONS <= covered


def test_every_wake_action_renders_a_prompt(fixtures, node_output):
    by_name = {r["name"]: r for r in node_output["single"]}
    rendered = {f["notification"].get("action") for f in fixtures["single"]
                if by_name[f["name"]].get("ok")}
    assert prompts.WAKE_ACTIONS <= rendered


def test_single_prompts_byte_identical(fixtures, node_output):
    for fixture, expected in zip(fixtures["single"], node_output["single"]):
        got = {"name": fixture["name"], **_render(lambda: prompts.build_prompt(fixture["notification"]))}
        if "error" in expected:
            assert "error" in got, fixture["name"]
            assert got["error"] == expected["error"], fixture["name"]
        else:
            assert got == expected, fixture["name"]
            if got["ok"] is not None:
                assert got["ok"].encode("utf-8") == expected["ok"].encode("utf-8")


def test_batch_prompts_byte_identical(fixtures, node_output):
    for fixture, expected in zip(fixtures["batch"], node_output["batch"]):
        got = {"name": fixture["name"], **_render(lambda: prompts.build_batch_prompt(fixture["notifications"]))}
        assert got == expected, fixture["name"]
