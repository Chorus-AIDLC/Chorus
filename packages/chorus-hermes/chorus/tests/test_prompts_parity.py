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


@pytest.mark.parametrize("actor_type", ["user", "agent"])
def test_mention_guidance_requires_sender_action(actor_type):
    prompt = prompts.build_prompt({
        "action": "mentioned", "entityType": "task", "entityUuid": "task-1",
        "actorName": "Alice", "actorType": actor_type, "actorUuid": "sender-1",
    })
    assert "Only if the sender must act on your result (a question, requested decision, or work handoff)" in prompt
    assert f"post a comment on this task using chorus_add_comment with @mention: @[Alice]({actor_type}:sender-1)" in prompt
    assert 'Never @mention only to acknowledge or say "received".' in prompt
    assert "After completing your work, post a comment" not in prompt


@pytest.mark.parametrize("entity_type", ["proposal", "task", "idea"])
def test_direct_review_wake_loads_protocol_before_reviewing(entity_type):
    prompt = prompts.build_prompt({
        "action": "mentioned", "entityType": entity_type, "entityUuid": "target-1",
        "actorName": "Alice", "actorType": "agent", "actorUuid": "sender-1",
        "message": "Please review…",
    })
    assert prompts.TEAM_REVIEW_MENTION_GUIDANCE in prompt
    assert "fetch the full comments" in prompt
    assert "Team review request — <kind>, round N" in prompt
    assert "load and follow the current installed matching reviewer instructions BEFORE reviewing" in prompt
    assert "proposal → proposal-reviewer, task → task-reviewer, code (whole-Idea) → code-reviewer" in prompt
    assert "corrected request and stop without a verdict" in prompt
    assert "exactly one final unformatted line starting at column 1: VERDICT: PASS, VERDICT: PASS WITH NOTES or VERDICT: FAIL" in prompt
    assert "No bold, backticks, bullet, quote, indentation or code fence" in prompt
    assert "exactly one actionable @mention" in prompt
    assert "proposal FAIL → current product delegate, else orchestrator" in prompt
    assert "task FAIL → current logical task developer" in prompt
    assert "whole-Idea FAIL → current orchestrator" in prompt
    assert "no second completion handoff" in prompt
    assert not any(line.startswith("VERDICT:") for line in prompt.splitlines())


def test_batch_prompts_byte_identical(fixtures, node_output):
    for fixture, expected in zip(fixtures["batch"], node_output["batch"]):
        got = {"name": fixture["name"], **_render(lambda: prompts.build_batch_prompt(fixture["notifications"]))}
        assert got == expected, fixture["name"]
