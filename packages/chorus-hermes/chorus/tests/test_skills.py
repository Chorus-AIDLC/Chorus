"""Packaged skill bundle: presence, registration, Hermes-only tool references, reviewer contract."""

import json
import re
import sys

import pytest
import yaml

from chorus_hermes import skills
from tests.conftest import PLUGIN_DIR, REPO_ROOT, load_plugin_module

SKILLS_DIR = PLUGIN_DIR / "skills"

REQUIRED_SKILLS = {
    "chorus", "idea", "brainstorm", "research", "proposal", "develop", "review", "quick-dev", "yolo",
    "orchestrate", "openspec-aware", "spec-lite", "chorus-cli", "docs",
    "chorus-proposal-reviewer", "chorus-task-reviewer", "chorus-code-reviewer",
}
# Tools/paths Hermes does not have (spec: hermes-skill-bundle "No foreign tool references").
FOREIGN_RE = re.compile(r"AskUserQuestion|spawn_agent|CLAUDE_PLUGIN_ROOT")
# Other host-specific mechanisms that must not leak into the Hermes copy.
OTHER_HOST_RE = re.compile(
    r"ask_user_question|request_user_input|wait_agent|close_agent|PLUGIN_ROOT|chorus-mcp-call\.sh|"
    r"chorus-api\.sh|~/\.pi/|\.pi/mcp\.json|/skill:|subagent\(|TeamCreate|~/\.codex")
# Hermes logs a prompt-injection warning when a plugin skill contains one of these (skills_tool_plugin.py).
INJECTION_PATTERNS = ("ignore previous instructions", "ignore all previous", "you are now", "disregard your",
                      "forget your instructions", "new instructions:", "system prompt:", "<system>", "]]>")
SKILL_NAME_RE = re.compile(r"^[a-zA-Z0-9_-]+$")


def _skill_files():
    return sorted(SKILLS_DIR.glob("*/SKILL.md"))


def _all_skill_text():
    return [(p, p.read_text(encoding="utf-8")) for p in SKILLS_DIR.rglob("*") if p.is_file()]


def _frontmatter(path):
    text = path.read_text(encoding="utf-8")
    assert text.startswith("---\n"), path
    return yaml.safe_load(text[4:text.index("\n---", 4)])


def test_required_skills_present():
    names = {p.parent.name for p in _skill_files()}
    assert REQUIRED_SKILLS <= names, sorted(REQUIRED_SKILLS - names)


@pytest.mark.parametrize("path", _skill_files(), ids=lambda p: p.parent.name)
def test_frontmatter(path):
    fm = _frontmatter(path)
    assert fm["name"] == path.parent.name
    assert SKILL_NAME_RE.match(fm["name"])
    assert isinstance(fm.get("description"), str) and fm["description"].strip()
    root_version = json.loads((REPO_ROOT / "package.json").read_text())["version"]
    assert str(fm["metadata"]["version"]) == root_version


def test_no_foreign_tool_references():
    hits = [f"{p.relative_to(SKILLS_DIR)}:{m.group(0)}" for p, text in _all_skill_text()
            for m in FOREIGN_RE.finditer(text)]
    assert hits == []


def test_no_other_host_mechanisms():
    hits = [f"{p.relative_to(SKILLS_DIR)}:{m.group(0)}" for p, text in _all_skill_text()
            for m in OTHER_HOST_RE.finditer(text)]
    assert hits == []


def test_foreign_grep_detects_violation():
    assert FOREIGN_RE.search("call AskUserQuestion({...})")
    assert FOREIGN_RE.search("spawn_agent({items: []})")
    assert FOREIGN_RE.search("${CLAUDE_PLUGIN_ROOT}/hooks")


def test_no_injection_scan_triggers():
    hits = [f"{p.relative_to(SKILLS_DIR)}:{pat}" for p, text in _all_skill_text()
            for pat in INJECTION_PATTERNS if pat in text.lower()]
    assert hits == []


def test_skills_use_hermes_mechanisms():
    text = {p.parent.name: p.read_text(encoding="utf-8") for p in _skill_files()}
    for name in ("develop", "review", "yolo", "orchestrate", "quick-dev", "proposal"):
        assert "delegate_task" in text[name], name
    for name in ("chorus", "develop", "idea"):
        assert 'skill_view("chorus:' in text[name], name
    for name in ("idea", "brainstorm"):
        assert "chorus_pm_start_elaboration" in text[name] or "elaboration round" in text[name], name
        assert "@mention" in text[name] or "chorus_add_comment" in text[name], name


@pytest.mark.parametrize("name", skills.REVIEWER_SKILLS)
def test_reviewer_contract(name):
    text = (SKILLS_DIR / name / "SKILL.md").read_text(encoding="utf-8")
    for verdict in ("VERDICT: PASS", "VERDICT: PASS WITH NOTES", "VERDICT: FAIL"):
        assert verdict in text
    assert "chorus_add_comment" in text
    assert "first line" in text.lower()
    assert re.search(r"round", text, re.I) and re.search(r"max(imum)? review rounds|round cap|rounds?\b.*cap",
                                                          text, re.I), "round cap missing"
    assert "B<round>-" in text and "N<round>-" in text
    assert "fixed" in text and "still-open" in text and "not-verifiable" in text
    assert f"[chorus-reviewer:{name.split('-')[1]}]" in text
    assert "evidence bundle" in text.lower() or name == "chorus-proposal-reviewer"


def test_reviewer_marker_kinds_match_skill_names():
    assert [n.split("-")[1] for n in skills.REVIEWER_SKILLS] == ["proposal", "task", "code"]


def test_register_registers_every_skill(fake_ctx):
    skills.register(fake_ctx)
    registered = set(fake_ctx.skills)
    assert registered == {p.parent.name for p in _skill_files()}
    assert REQUIRED_SKILLS <= registered
    for name, entry in fake_ctx.skills.items():
        assert entry["path"].name == "SKILL.md" and entry["path"].exists()
        assert entry["description"], name


def test_one_bad_skill_does_not_stop_others(fake_ctx, tmp_path):
    for name in ("a", "b"):
        (tmp_path / name).mkdir()
        (tmp_path / name / "SKILL.md").write_text(f"---\nname: {name}\ndescription: d {name}\n---\nbody\n")

    calls = []

    def flaky(name, path, description=""):
        calls.append(name)
        if name == "a":
            raise ValueError("boom")
        fake_ctx.skills[name] = dict(path=path, description=description)

    fake_ctx.register_skill = flaky
    skills.register(fake_ctx, skills_root=tmp_path)
    assert calls == ["a", "b"] and set(fake_ctx.skills) == {"b"}
    assert {"pre_tool_call", "subagent_start", "subagent_stop"} <= set(fake_ctx.hooks)


def test_discover_handles_missing_dir(tmp_path):
    assert skills.discover_skills(tmp_path / "nope") == []


def test_plugin_entry_point_registers_skills(fake_ctx, monkeypatch):
    module = load_plugin_module()
    # Hermes' loader puts the plugin package in sys.modules so register() can import its features.
    monkeypatch.setitem(sys.modules, module.__name__, module)
    module.register(fake_ctx)
    assert REQUIRED_SKILLS <= set(fake_ctx.skills)
    assert {"pre_tool_call", "subagent_start", "subagent_stop"} <= set(fake_ctx.hooks)
