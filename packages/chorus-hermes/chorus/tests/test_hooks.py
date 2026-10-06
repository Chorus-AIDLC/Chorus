import json
from concurrent.futures import Future

import pytest

from chorus_hermes import hooks as h
from chorus_hermes.mcp_client import McpError
from chorus_hermes.spec_mode import SpecMode
from tests.conftest import FAKE_KEY, FAKE_URL

ENV = {"CHORUS_URL": FAKE_URL, "CHORUS_API_KEY": FAKE_KEY}
SPEC = SpecMode(mode="lite", reason="default — test")


class FakeClient:
    def __init__(self, owner, timeout):
        self.owner, self.timeout = owner, timeout

    def call_tool(self, name, args=None):
        self.owner.calls.append((name, args, self.timeout))
        if self.owner.fail:
            raise McpError("Chorus MCP request failed: ConnectError")
        return self.owner.reply


class Backend:
    def __init__(self, reply=None, fail=False):
        self.reply = {"agent": {"uuid": "a1", "name": "Clay"}} if reply is None else reply
        self.fail = fail
        self.calls = []

    def factory(self, cfg, timeout):
        assert cfg.api_key == FAKE_KEY
        return FakeClient(self, timeout)


class SyncExecutor:
    def submit(self, fn, *args):
        fut = Future()
        try:
            fut.set_result(fn(*args))
        except Exception as exc:  # noqa: BLE001
            fut.set_exception(exc)
        return fut


def make(backend=None, env=ENV, **kw):
    backend = backend or Backend()
    hooks = h.ChorusHooks(env=env, client_factory=backend.factory, project_root=lambda: "/repo",
                          resolve_spec=lambda root, env: SPEC, executor=SyncExecutor(), **kw)
    return hooks, backend


def user(text, api_content=None):
    msg = {"role": "user", "content": text}
    if api_content is not None:
        msg["api_content"] = api_content
    return msg


def turn(hooks, sid, history, first=False):
    return hooks.pre_llm_call(session_id=sid, conversation_history=history, is_first_turn=first,
                              user_message="hi", model="m", platform="cli")


# --- pre_llm_call ---------------------------------------------------------------

def test_first_turn_injects_sections_once():
    hooks, backend = make()
    out = turn(hooks, "s1", [user("hi")], first=True)
    ctx = out["context"]
    assert h.MARKER in ctx
    for section in ("## Checkin", "## Spec Mode", "## Quick Reference"):
        assert section in ctx
    assert '"name": "Clay"' in ctx and "CHORUS_SPEC_MODE=lite (default — test)" in ctx
    assert 'skill_view("chorus:<name>")' in ctx
    assert len(ctx) <= h.MAX_CONTEXT_CHARS
    # Later turns: history carries the injected marker in the api_content sidecar.
    hist = [user("hi", "hi\n\n" + ctx), {"role": "assistant", "content": "ok"}, user("next")]
    assert turn(hooks, "s1", hist) is None
    hist += [{"role": "assistant", "content": "ok"}, user("third")]
    assert turn(hooks, "s1", hist) is None
    assert [c[0] for c in backend.calls] == ["chorus_checkin"]


def test_reinjects_once_after_session_reset():
    hooks, backend = make()
    ctx = turn(hooks, "s1", [user("hi")], first=True)["context"]
    hist = [user("hi", ctx), {"role": "assistant", "content": "ok"}, user("next")]
    assert turn(hooks, "s1", hist) is None
    # CLI-style reset keeps reporting the same id; gateway passes old/new ids.
    hooks.on_session_reset(session_id="s1", platform="cli", reason="new_session")
    assert "## Checkin" in turn(hooks, "s1", hist + [user("after reset")])["context"]
    assert turn(hooks, "s1", hist + [user("after reset", "x " + h.MARKER), user("again")]) is None
    assert len(backend.calls) == 2


def test_gateway_reset_new_session_id():
    hooks, _ = make()
    ctx = turn(hooks, "old", [user("hi")], first=True)["context"]
    hooks.on_session_reset(session_id="new", old_session_id="old", new_session_id="new", reason="new_session")
    assert "old" not in hooks._sessions
    # the first turn of the replacement session reports is_first_turn; injected exactly once
    assert "## Checkin" in turn(hooks, "new", [user("hello")], first=True)["context"]
    assert turn(hooks, "new", [user("hello", ctx), user("more")]) is None


def test_reinjects_once_after_compression_marker_evicted():
    hooks, backend = make()
    ctx = turn(hooks, "s1", [user("hi")], first=True)["context"]
    long_hist = [user("hi", ctx)] + [{"role": "assistant", "content": f"m{i}"} for i in range(10)] + [user("q")]
    assert turn(hooks, "s1", long_hist) is None
    compressed = [{"role": "user", "content": "[CONTEXT COMPACTION] summary of earlier turns"}, user("q2")]
    out = turn(hooks, "s1", compressed)
    assert out is not None and "## Spec Mode" in out["context"]
    assert turn(hooks, "s1", compressed + [user("q2", out["context"]), user("q3")]) is None
    assert len(backend.calls) == 2


def test_reinjects_after_compression_when_marker_not_visible():
    """Hosts that strip the sidecar from history: the shrink in length signals compaction."""
    hooks, _ = make()
    turn(hooks, "s1", [user("hi")], first=True)
    grown = [user("hi")] + [{"role": "assistant", "content": "x"}] * 20
    assert turn(hooks, "s1", grown) is None
    assert turn(hooks, "s1", grown + [user("more")]) is None
    assert "## Checkin" in turn(hooks, "s1", [user("summary"), user("next")])["context"]
    assert turn(hooks, "s1", [user("summary"), user("next"), user("n2")]) is None


def test_unknown_session_with_history_is_resume():
    hooks, _ = make()
    assert "## Checkin" in turn(hooks, "resumed", [user("old"), {"role": "assistant", "content": "x"}])["context"]
    # A resumed session whose history already carries the marker is left alone.
    hooks2, backend2 = make()
    assert turn(hooks2, "r2", [user("old", "ctx " + h.MARKER), user("new")]) is None
    assert backend2.calls == []


def test_multimodal_marker_detected():
    hooks, _ = make()
    turn(hooks, "s1", [user("hi")], first=True)
    hist = [{"role": "user", "content": [{"type": "text", "text": "hi"}, {"type": "text", "text": h.MARKER}]},
            user("x")]
    assert turn(hooks, "s1", hist) is None


def test_checkin_failure_injects_one_line_notice():
    hooks, _ = make(Backend(fail=True))
    out = turn(hooks, "s1", [user("hi")], first=True)
    ctx = out["context"]
    assert "\n" not in ctx
    assert "Chorus check-in failed" in ctx and FAKE_URL in ctx and FAKE_KEY not in ctx
    assert turn(hooks, "s1", [user("hi", ctx), user("again")]) is None


def test_not_configured_notice():
    hooks, backend = make(env={})
    ctx = turn(hooks, "s1", [user("hi")], first=True)["context"]
    assert "not configured" in ctx and "\n" not in ctx
    assert backend.calls == []


def test_context_capped_at_5000_chars():
    big = {"notifications": [{"text": "x" * 500} for _ in range(40)]}
    hooks, _ = make(Backend(reply=big))
    ctx = turn(hooks, "s1", [user("hi")], first=True)["context"]
    assert len(ctx) <= 5000
    assert "## Spec Mode" in ctx and "## Quick Reference" in ctx and "(truncated)" in ctx


@pytest.mark.parametrize("mode,needle", [
    (SpecMode("openspec", "default", openspec_usable=True, openspec_usable_reason="both"),
     "CHORUS_OPENSPEC_ACTIVE=1 (both)"),
    (SpecMode("openspec", "explicit", fail="OpenSpec not usable (x)", hint="npm i"), "cannot be honored"),
    (SpecMode("off", "explicit"), "Routing: off"),
    (SpecMode("lite", "default"), 'skill_view("chorus:spec-lite")'),
])
def test_spec_mode_routing(mode, needle):
    block = h.build_context_block(FAKE_URL, {"a": 1}, mode)
    assert needle in block and len(block) <= 5000


def test_pre_llm_call_never_raises():
    def bad_resolve(*a):
        raise RuntimeError("boom")
    hooks, _ = make()
    hooks._resolve_spec = bad_resolve
    assert "## Checkin" in turn(hooks, "s1", [user("hi")], first=True)["context"]  # falls back to lite
    hooks._injection_reason = None  # type: ignore[assignment]
    assert turn(hooks, "s2", [], first=True) is None


def test_session_start_warms_checkin_used_by_first_turn():
    backend = Backend()
    hooks, _ = make(backend)
    hooks.on_session_start(session_id="s1", model="m", platform="cli")
    assert len(backend.calls) == 1 and backend.calls[0][2] == h.CHECKIN_TIMEOUT
    assert "## Checkin" in turn(hooks, "s1", [user("hi")], first=True)["context"]
    assert len(backend.calls) == 1  # consumed the warmed result


def test_session_start_stale_prefetch_refetched():
    now = [0.0]
    hooks, backend = make(clock=lambda: now[0])
    hooks.on_session_start(session_id="s1")
    now[0] = h.PREFETCH_MAX_AGE + 1
    turn(hooks, "s1", [user("hi")], first=True)
    assert len(backend.calls) == 2


def test_session_start_failure_is_swallowed():
    hooks, _ = make(Backend(fail=True))
    assert hooks.on_session_start(session_id="s1") is None
    assert "check-in failed" in turn(hooks, "s1", [user("hi")], first=True)["context"]


# --- transform_tool_result --------------------------------------------------------

def mcp_ok(payload):
    return json.dumps({"result": json.dumps(payload)})


@pytest.mark.parametrize("kw", [{"platform": "subagent"}, {"platform": "cli", "parent_session_id": "parent-1"},
                                {"platform": "subagent", "parent_session_id": "parent-1"}])
def test_delegate_task_children_never_check_in(kw):
    hooks, backend = make()
    hooks.on_session_start(session_id="child-1", **kw)
    out = hooks.pre_llm_call(session_id="child-1", conversation_history=[user("review")], is_first_turn=True,
                             user_message="review", model="m", **kw)
    assert out is None and backend.calls == []


def test_top_level_session_with_empty_parent_still_checks_in():
    hooks, backend = make()
    hooks.on_session_start(session_id="s1", platform="chorus")
    out = hooks.pre_llm_call(session_id="s1", conversation_history=[user("hi")], is_first_turn=True,
                             user_message="hi", model="m", platform="chorus", parent_session_id="")
    assert h.MARKER in out["context"] and [c[0] for c in backend.calls] == ["chorus_checkin"]


def test_submit_proposal_reminder_appended():
    hooks, _ = make()
    res = mcp_ok({"uuid": "prop-9", "status": "pending"})
    out = hooks.transform_tool_result(tool_name="mcp__chorus__chorus_pm_submit_proposal",
                                      args={"proposalUuid": "prop-9"}, result=res, status="ok")
    assert out.startswith(res + "\n\n[Chorus — Proposal Submitted for Review]")
    assert "Proposal prop-9" in out and "delegate_task" in out and "[chorus-reviewer:proposal]" in out


def test_submit_for_verify_uuid_from_args_fallback():
    hooks, _ = make()
    res = json.dumps({"result": "Task submitted"})
    out = hooks.transform_tool_result(tool_name="x_chorus_submit_for_verify", args={"taskUuid": "t-7"},
                                      result=res, status="ok")
    assert "Task t-7 has been submitted" in out and "[chorus-reviewer:task]" in out


def test_verify_task_branches_wired():
    seen = {}

    def fake_verify(task_uuid, call, *, project_root, env):
        seen.update(task=task_uuid, root=project_root, out=call("chorus_get_task", {"taskUuid": task_uuid}))
        return "[A][C][B]"
    backend = Backend(reply={"proposalUuid": None})
    hooks, _ = make(backend, verify_reminders=fake_verify)
    res = mcp_ok({"uuid": "t-1", "status": "done"})
    out = hooks.transform_tool_result(tool_name="mcp__chorus__chorus_admin_verify_task", args={"taskUuid": "t-1"},
                                      result=res, status="ok")
    assert out == res + "\n\n[A][C][B]"
    assert seen["task"] == "t-1" and seen["root"] == "/repo"
    assert backend.calls[0][2] == h.REMINDER_CALL_TIMEOUT


def test_verify_task_no_reminder_returns_none():
    hooks, _ = make(verify_reminders=lambda *a, **k: "")
    assert hooks.transform_tool_result(tool_name="chorus_admin_verify_task", args={"taskUuid": "t"},
                                       result=mcp_ok({"uuid": "t"}), status="ok") is None


def test_verify_task_exception_returns_original():
    def boom(*a, **k):
        raise RuntimeError("x")
    hooks, _ = make(verify_reminders=boom)
    assert hooks.transform_tool_result(tool_name="chorus_admin_verify_task", args={"taskUuid": "t"},
                                       result=mcp_ok({"uuid": "t"}), status="ok") is None


def test_verify_task_real_branches_with_unreachable_chorus():
    hooks, _ = make(Backend(fail=True))
    assert hooks.transform_tool_result(tool_name="chorus_admin_verify_task", args={"taskUuid": "t"},
                                       result=mcp_ok({"uuid": "t"}), status="ok") is None


@pytest.mark.parametrize("result,status", [
    (json.dumps({"error": "Task not found"}), "error"),
    (json.dumps({"error": "Task not found"}), None),
    (mcp_ok({"uuid": "p"}), "error"),
    (None, "ok"),
])
def test_failed_calls_untouched(result, status):
    hooks, _ = make()
    assert hooks.transform_tool_result(tool_name="mcp__chorus__chorus_pm_submit_proposal", args={},
                                       result=result, status=status) is None


@pytest.mark.parametrize("name", ["read_file", "mcp__chorus__chorus_get_task", "chorus_pm_submit_proposal_x",
                                  "terminal", ""])
def test_unrelated_tools_untouched(name):
    hooks, backend = make()
    assert hooks.transform_tool_result(tool_name=name, args={}, result=mcp_ok({"a": 1}), status="ok") is None
    assert backend.calls == []


def test_non_json_result_still_gets_reminder():
    hooks, _ = make()
    out = hooks.transform_tool_result(tool_name="chorus_pm_submit_proposal", args={"proposalUuid": "p1"},
                                      result="plain", status="ok")
    assert out.startswith("plain\n\n") and "Proposal p1" in out


# --- registration ----------------------------------------------------------------

def test_register_hooks(fake_ctx):
    h.register(fake_ctx)
    assert sorted(fake_ctx.hooks) == sorted(h.HOOK_NAMES)
    assert all(len(v) == 1 for v in fake_ctx.hooks.values())


def test_hook_names_are_valid_hermes_hooks():
    # Mirrors hermes_cli/plugins.py VALID_HOOKS at Hermes 2b52acc2d.
    valid = {"pre_llm_call", "on_session_start", "on_session_reset", "transform_tool_result"}
    assert set(h.HOOK_NAMES) <= valid
