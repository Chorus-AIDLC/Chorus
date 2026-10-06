"""Reviewer read-only guard: subagent_start / pre_tool_call / subagent_stop."""

import pytest

from chorus_hermes import skills
from chorus_hermes.skills import ReviewerGuard, base_tool_name, find_marker, is_reviewer_allowed

PARENT = "parent-sid"
CHILD = "child-sid"


@pytest.fixture
def guard():
    return ReviewerGuard()


def _start_reviewer(guard, kind="task", *, marker_in="context", goal=None):
    goal = goal or f"Review Chorus {kind} 1234 and post one VERDICT comment."
    context = f"[chorus-reviewer:{kind}]\nFirst call skill_view(\"chorus:chorus-{kind}-reviewer\")."
    if marker_in == "goal":
        goal, context = f"[chorus-reviewer:{kind}] {goal}", "no marker here"
    assert guard.on_pre_tool_call(tool_name="delegate_task", args={"goal": goal, "context": context},
                                  session_id=PARENT) is None
    guard.on_subagent_start(parent_session_id=PARENT, child_session_id=CHILD, child_goal=goal)
    return goal


def _call(guard, tool, session_id=CHILD):
    return guard.on_pre_tool_call(tool_name=tool, args={}, session_id=session_id, task_id="t")


def test_find_marker_and_names():
    assert find_marker("x", "[chorus-reviewer:proposal] y") == "proposal"
    assert find_marker(None, "nothing") is None
    assert base_tool_name("mcp__chorus__chorus_get_task") == ("chorus_get_task", True)
    assert base_tool_name("terminal") == ("terminal", False)


@pytest.mark.parametrize("marker_in", ["context", "goal"])
@pytest.mark.parametrize("tool", [
    "mcp__chorus__chorus_admin_approve_proposal", "chorus_admin_approve_proposal",
    "mcp__chorus__chorus_update_task", "mcp__chorus__chorus_admin_verify_task",
    "mcp__chorus__chorus_pm_create_idea", "mcp__chorus__chorus_create_session",
    "write_file", "patch", "terminal", "execute_code", "delegate_task", "memory", "skill_manage",
    "some_unknown_tool", "mcp__chorus__chorus_admin_move_pr_7f3a9c21",  # hash-clamped name
])
def test_reviewer_write_tools_blocked(guard, marker_in, tool):
    _start_reviewer(guard, marker_in=marker_in)
    result = _call(guard, tool)
    assert result["action"] == "block"
    assert "read-only" in result["message"] and tool in result["message"]


@pytest.mark.parametrize("tool", [
    "mcp__chorus__chorus_add_comment", "mcp__chorus__chorus_get_task", "mcp__chorus__chorus_get_proposal",
    "mcp__chorus__chorus_list_tasks", "mcp__chorus__chorus_search", "mcp__chorus__chorus_get_comments",
    "mcp__chorus__chorus_checkin", "mcp__chorus__read_resource", "chorus_get_task",
    "read_file", "search_files", "skill_view", "skills_list", "web_search",
])
def test_reviewer_read_tools_allowed(guard, tool):
    _start_reviewer(guard)
    assert _call(guard, tool) is None


def test_non_reviewer_sessions_untouched(guard):
    _start_reviewer(guard)
    for tool in ("terminal", "write_file", "mcp__chorus__chorus_admin_approve_proposal"):
        assert _call(guard, tool, session_id=PARENT) is None
        assert _call(guard, tool, session_id="other") is None


def test_unmarked_child_is_not_a_reviewer(guard):
    guard.on_pre_tool_call(tool_name="delegate_task", args={"goal": "implement task", "context": "plain"},
                           session_id=PARENT)
    guard.on_subagent_start(parent_session_id=PARENT, child_session_id=CHILD, child_goal="implement task")
    assert _call(guard, "terminal") is None


def test_subagent_stop_clears(guard):
    _start_reviewer(guard)
    assert _call(guard, "terminal")["action"] == "block"
    guard.on_subagent_stop(parent_session_id=PARENT, child_session_id=CHILD, child_status="completed")
    assert _call(guard, "terminal") is None
    assert guard.reviewer_kind(CHILD) is None


def test_batch_marks_only_marked_children(guard):
    args = {"tasks": [
        {"goal": "Review proposal P", "context": "[chorus-reviewer:proposal]\nP"},
        {"goal": "Implement task T", "context": "worker"},
    ]}
    guard.on_pre_tool_call(tool_name="delegate_task", args=args, session_id=PARENT)
    guard.on_subagent_start(parent_session_id=PARENT, child_session_id="c1", child_goal="Review proposal P")
    guard.on_subagent_start(parent_session_id=PARENT, child_session_id="c2", child_goal="Implement task T")
    assert guard.reviewer_kind("c1") == "proposal"
    assert guard.reviewer_kind("c2") is None
    assert _call(guard, "patch", session_id="c1")["action"] == "block"
    assert _call(guard, "patch", session_id="c2") is None


def test_batch_tasks_as_json_string(guard):
    args = {"tasks": '[{"goal": "Review code I", "context": "[chorus-reviewer:code] I"}]'}
    guard.on_pre_tool_call(tool_name="delegate_task", args=args, session_id=PARENT)
    guard.on_subagent_start(parent_session_id=PARENT, child_session_id=CHILD, child_goal="Review code I")
    assert guard.reviewer_kind(CHILD) == "code"


def test_pending_is_scoped_to_parent_session(guard):
    guard.on_pre_tool_call(tool_name="delegate_task",
                           args={"goal": "Review", "context": "[chorus-reviewer:task]"}, session_id=PARENT)
    guard.on_subagent_start(parent_session_id="someone-else", child_session_id=CHILD, child_goal="Review")
    assert guard.reviewer_kind(CHILD) is None


def test_pending_expires():
    now = [0.0]
    guard = ReviewerGuard(clock=lambda: now[0])
    guard.on_pre_tool_call(tool_name="delegate_task",
                           args={"goal": "Review", "context": "[chorus-reviewer:task]"}, session_id=PARENT)
    now[0] = skills.PENDING_TTL_SECONDS + 1
    guard.on_pre_tool_call(tool_name="delegate_task", args={"goal": "other"}, session_id=PARENT)
    guard.on_subagent_start(parent_session_id=PARENT, child_session_id=CHILD, child_goal="Review")
    assert guard.reviewer_kind(CHILD) is None


def test_child_of_reviewer_inherits(guard):
    _start_reviewer(guard)
    guard.on_subagent_start(parent_session_id=CHILD, child_session_id="grandchild", child_goal="x")
    assert guard.reviewer_kind("grandchild") == "task"


def test_hooks_never_raise(guard):
    assert guard.on_pre_tool_call(tool_name="delegate_task", args="garbage", session_id=PARENT) is None
    assert guard.on_pre_tool_call() is None
    guard.on_subagent_start()
    guard.on_subagent_start(child_session_id=CHILD, child_goal=None)
    guard.on_subagent_stop()


def test_allowlist_function():
    assert is_reviewer_allowed("mcp__chorus__chorus_add_comment")
    assert not is_reviewer_allowed("mcp__chorus__chorus_pm_submit_proposal")
    assert not is_reviewer_allowed("mcp__other__write_stuff")


def test_register_wires_guard_hooks(fake_ctx):
    guard = ReviewerGuard()
    skills.register(fake_ctx, guard=guard)
    assert set(fake_ctx.hooks) >= {"pre_tool_call", "subagent_start", "subagent_stop"}
    (pre,) = fake_ctx.hooks["pre_tool_call"]
    (start,) = fake_ctx.hooks["subagent_start"]
    (stop,) = fake_ctx.hooks["subagent_stop"]
    start(parent_session_id=PARENT, child_session_id=CHILD, child_goal="[chorus-reviewer:code] review")
    assert pre(tool_name="terminal", args={}, session_id=CHILD)["action"] == "block"
    stop(child_session_id=CHILD)
    assert pre(tool_name="terminal", args={}, session_id=CHILD) is None
