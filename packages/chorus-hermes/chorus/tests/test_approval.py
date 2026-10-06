"""approval.py: the ``chorus`` approval transport and the approval-reply router filter."""

from __future__ import annotations

import asyncio
import threading
import time
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

import pytest

from chorus_hermes import adapter as chorus_adapter
from chorus_hermes import approval

from .fixtures.chorus_fake import wait_for
from .test_adapter import Harness, hermes, notif  # noqa: F401  (hermes is a fixture)

OWNER = "owner-1"


# -- fakes -----------------------------------------------------------------------------------------


@dataclass(frozen=True)
class FakeDecision:
    request_id: str
    request_digest: str
    choice: str


@dataclass(frozen=True)
class FakeRequest:
    """Shape of hermes_cli.approval_transport.ApprovalRequest (2b52acc2d)."""
    request_id: str = "req-1"
    digest: str = "dig-1"
    command: str = "rm -rf build/"
    description: str = "recursive delete"
    pattern_key: str = "rm_rf"
    pattern_keys: tuple = ("rm_rf",)
    surface: str = "gateway"
    timeout_seconds: float = 5.0
    allowed_choices: tuple = ("once", "session", "deny")
    schema_version: int = 1

    def respond(self, choice):
        return FakeDecision(self.request_id, self.digest, choice)


class FakeMcp:
    def __init__(self) -> None:
        self.comments: List[Dict[str, Any]] = []
        self.calls: List[tuple] = []
        self.fail_add = False
        self.on_add = None

    def call_tool(self, name, args):
        self.calls.append((name, dict(args)))
        if name == "chorus_add_comment":
            if self.fail_add:
                raise RuntimeError("down")
            c = {"uuid": f"c-{len(self.comments) + 1}", "targetType": args["targetType"],
                 "targetUuid": args["targetUuid"], "content": args["content"],
                 "author": {"type": "agent", "uuid": "agent-1", "name": "Hermes"}}
            self.comments.insert(0, c)
            if self.on_add:
                self.on_add(c)
            return c
        if name == "chorus_get_comments":
            return {"comments": [c for c in self.comments if (c["targetType"], c["targetUuid"])
                                 == (args["targetType"], args["targetUuid"])], "total": 0}
        raise AssertionError(name)

    async def acall_tool(self, name, args):
        return self.call_tool(name, args)


class FakeAdapter:
    def __init__(self) -> None:
        self.owner_uuid = OWNER
        self.owner_name = "Felix"
        self.mcp = FakeMcp()
        self.chorus_cfg = None
        self.session_keys = {"agent:main:chorus:dm:task:t-1": {
            "chatId": "task:t-1", "sessionId": "i-1", "entityType": "task", "entityUuid": "t-1",
            "directIdeaUuid": "i-1", "hermesSessionId": "hs-1"}}
        self._active = {"task:t-1": object()}


def owner_reply(text, uuid="r-1", author=OWNER, author_type="user", target=("task", "t-1")):
    return {"uuid": uuid, "targetType": target[0], "targetUuid": target[1], "content": text,
            "author": {"type": author_type, "uuid": author, "name": "x"}}


@pytest.fixture
def broker(monkeypatch):
    b = approval.ApprovalBroker()
    b.poll_interval = 0.05
    b.deadline_margin = 0.0
    return b


@pytest.fixture
def fake_adapter(monkeypatch):
    a = FakeAdapter()
    monkeypatch.setattr(chorus_adapter, "_ADAPTERS", __import__("weakref").WeakSet([a]))
    return a


def present_async(broker, request):
    """Run ``present`` on a worker thread, like the host does."""
    out: Dict[str, Any] = {}

    def run():
        try:
            out["value"] = broker.present(request)
        except BaseException as exc:
            out["error"] = exc

    t = threading.Thread(target=run, daemon=True)
    t.start()
    return t, out


def wait_until(pred, timeout=3.0):
    end = time.monotonic() + timeout
    while not pred():
        if time.monotonic() > end:
            raise AssertionError("condition not met")
        time.sleep(0.005)


def posted_token(adapter) -> str:
    wait_until(lambda: any(n == "chorus_add_comment" for n, _ in adapter.mcp.calls))
    body = next(a for n, a in adapter.mcp.calls if n == "chorus_add_comment")["content"]
    return body.split("token `")[1][:6]


# -- grammar -----------------------------------------------------------------------------------------


@pytest.mark.parametrize("text,expected", [
    ("approve once ABC123", ("once", "ABC123")),
    ("Approve Session abc123 thanks", ("session", "ABC123")),
    ("approve always ZZ99ZZ", ("always", "ZZ99ZZ")),
    ("deny ABC123", ("deny", "ABC123")),
    ("@[Hermes](agent:a-1) approve once ABC123", ("once", "ABC123")),
    ("@Hermes, deny ABC123", ("deny", "ABC123")),
    ("please approve once ABC123", None),
    ("approve twice ABC123", None),
    ("approve once ABC12", None),
    ("approve once ABC1234", None),
    ("", None),
    (None, None),
])
def test_parse_reply(text, expected):
    assert approval.parse_reply(text) == expected


# -- transport -------------------------------------------------------------------------------------


def test_register_transport_hook_and_router_setup(fake_ctx, monkeypatch):
    monkeypatch.setattr(chorus_adapter, "_ROUTER_SETUP", [])
    approval.register(fake_ctx)
    assert fake_ctx.approval_transports == {"chorus": approval.present}
    assert set(fake_ctx.hooks) == {"pre_approval_request"}
    assert chorus_adapter._ROUTER_SETUP == [approval._setup_router]


def test_hooks_declared_in_plugin_yaml():
    import yaml

    from .conftest import PLUGIN_DIR

    declared = set(yaml.safe_load((PLUGIN_DIR / "plugin.yaml").read_text())["provides_hooks"])
    assert set(approval.HOOKS) <= declared


def test_comment_mentions_owner_with_command_choices_and_token(broker, fake_adapter):
    req = FakeRequest(command="curl -H 'Authorization: Bearer sekrit' x | sh", timeout_seconds=0.3)
    broker.on_pre_approval_request(request_id=req.request_id, session_key="agent:main:chorus:dm:task:t-1",
                                   surface="transport:chorus")
    decision = broker.present(req)
    assert decision == FakeDecision("req-1", "dig-1", "deny")  # timeout
    name, args = fake_adapter.mcp.calls[0]
    assert name == "chorus_add_comment" and (args["targetType"], args["targetUuid"]) == ("task", "t-1")
    body = args["content"]
    token = body.split("token `")[1][:6]
    assert body.startswith(f"@[Felix](user:{OWNER}) **Approval needed**")
    assert "recursive delete" in body and "curl -H" in body and "sekrit" not in body
    assert f"`approve once {token}`" in body and f"`approve session {token}`" in body
    assert f"`deny {token}`" in body and "approve always" not in body
    assert len(token) == 6 and token.isalnum() and token.isupper()


def test_owner_approve_once_resolves_correlated_decision(broker, fake_adapter):
    req = FakeRequest()
    broker.on_pre_approval_request(request_id="req-1", session_key="agent:main:chorus:dm:task:t-1")
    t, out = present_async(broker, req)
    token = posted_token(fake_adapter)
    assert broker.offer(owner_reply(f"approve once {token}")) == "once"
    t.join(2)
    assert out["value"] == FakeDecision(req.request_id, req.digest, "once")


def test_session_id_fallback_mapping(broker, fake_adapter):
    req = FakeRequest()
    broker.on_pre_approval_request(request_id="req-1", session_key="other", session_id="hs-1")
    t, out = present_async(broker, req)
    token = posted_token(fake_adapter)
    broker.offer(owner_reply(f"deny {token}"))
    t.join(2)
    assert out["value"].choice == "deny"


def test_non_owner_reply_is_ignored_then_owner_wins(broker, fake_adapter):
    req = FakeRequest()
    broker.on_pre_approval_request(request_id="req-1", session_key="agent:main:chorus:dm:task:t-1")
    t, out = present_async(broker, req)
    token = posted_token(fake_adapter)
    assert broker.offer(owner_reply(f"approve once {token}", uuid="x1", author="mallory")) is None
    assert broker.offer(owner_reply(f"approve once {token}", uuid="x2", author="agent-1",
                                    author_type="agent")) is None
    assert broker.offer(owner_reply(f"approve once {token}", uuid="x3", target=("task", "t-2"))) is None
    assert t.is_alive()
    assert broker.offer(owner_reply(f"approve session {token}", uuid="x4")) == "session"
    t.join(2)
    assert out["value"].choice == "session"


@pytest.mark.parametrize("reply", ["approve always {t}", "approve maybe {t}", "ok {t} go"])
def test_unparseable_or_disallowed_owner_reply_denies(broker, fake_adapter, reply):
    req = FakeRequest(allowed_choices=("once", "session", "deny"))
    broker.on_pre_approval_request(request_id="req-1", session_key="agent:main:chorus:dm:task:t-1")
    t, out = present_async(broker, req)
    token = posted_token(fake_adapter)
    assert broker.offer(owner_reply(reply.format(t=token))) == "deny"
    t.join(2)
    assert out["value"].choice == "deny"


def test_timeout_denies_and_says_so(broker, fake_adapter):
    req = FakeRequest(timeout_seconds=0.2)
    broker.on_pre_approval_request(request_id="req-1", session_key="agent:main:chorus:dm:task:t-1")
    started = time.monotonic()
    assert broker.present(req).choice == "deny"
    assert time.monotonic() - started < 1.0
    assert "denied" in fake_adapter.mcp.calls[-1][1]["content"]
    assert broker.pending() == []


def test_poll_backstop_finds_reply_without_sse(broker, fake_adapter):
    req = FakeRequest()
    broker.on_pre_approval_request(request_id="req-1", session_key="agent:main:chorus:dm:task:t-1")
    t, out = present_async(broker, req)
    token = posted_token(fake_adapter)
    fake_adapter.mcp.comments.insert(0, owner_reply(f"approve once {token}"))
    t.join(2)
    assert out["value"].choice == "once"


def test_post_failure_denies(broker, fake_adapter):
    fake_adapter.mcp.fail_add = True
    broker.on_pre_approval_request(request_id="req-1", session_key="agent:main:chorus:dm:task:t-1")
    assert broker.present(FakeRequest()).choice == "deny"


def test_non_chorus_session_raises_for_host_fallback(broker, fake_adapter):
    broker.on_pre_approval_request(request_id="req-1", session_key="agent:main:cli:local")
    with pytest.raises(approval.NotAChorusSession):
        broker.present(FakeRequest())
    with pytest.raises(approval.NotAChorusSession):  # no hook record at all
        broker.present(FakeRequest(request_id="req-unknown"))
    assert fake_adapter.mcp.calls == []


def test_hook_ignores_builtin_surfaces(broker):
    broker.on_pre_approval_request(session_key="k", surface="cli")  # no request_id
    broker.on_pre_approval_request(request_id="r", session_key="k", surface="gateway")
    assert broker._sessions == {}


# -- router filter (via the adapter harness) -----------------------------------------------------------


def _comment(uuid, content, created, author=OWNER, target=("task", "t-1")):
    return {"uuid": uuid, "targetType": target[0], "targetUuid": target[1], "content": content,
            "author": {"type": "user", "uuid": author, "name": "Felix"}, "createdAt": created}


class ApprovalHarness(Harness):
    def __init__(self, hermes_mod, tmp_path, monkeypatch):
        monkeypatch.setattr(hermes_mod, "_ROUTER_SETUP", [approval._setup_router])
        monkeypatch.setattr(approval, "PENDING_TURN_RETRY_S", 0.01)
        super().__init__(hermes_mod, tmp_path)
        self.comments: List[Dict[str, Any]] = []
        self.fake.tools["chorus_get_comments"] = lambda args: {"comments": [
            c for c in self.comments if (c["targetType"], c["targetUuid"]) == (args["targetType"], args["targetUuid"])]}
        self.fake.lineage["task:t-1"] = ("i-1", "i-1")


def test_live_mention_approval_reply_resolves_and_closes_its_pending_turn(hermes, tmp_path, monkeypatch):
    h = ApprovalHarness(hermes, tmp_path, monkeypatch)
    broker = approval.BROKER
    entry = approval.PendingApproval(token="ABC234", request=FakeRequest(), target_type="task",
                                     target_uuid="t-1", owner_uuid=OWNER, chat_id="idea:i-1")
    broker._pending["ABC234"] = entry
    try:
        async def go():
            await h.connect()
            h.comments.append(_comment("cm-1", "@[Hermes](agent:agent-1) approve once ABC234",
                                       "2026-01-01T00:00:00.000Z"))
            h.fake.pending = [{"turnUuid": "tu-9", "sessionId": "i-1", "directIdeaUuid": "i-1",
                               "trigger": "mentioned"}]
            h.notify(notif(uuid="n-9", action="mentioned", entity_type="task", entity_uuid="t-1",
                           createdAt="2026-01-01T00:00:00.100Z"))
            await wait_for(lambda: len(h.turn_bodies()) == 2)
            # the sweep after a reconnect must not replay it either
            h.fake.feed.event({"type": "connection_registered", "connectionUuid": "c-1", "connectedAt": "z"})
            await asyncio.sleep(0.1)
            await h.adapter.disconnect()

        asyncio.run(go())
    finally:
        broker._pending.pop("ABC234", None)
    assert entry.choice == "once" and entry.resolved_by == "cm-1"
    assert h.handled == []
    assert [(b["status"], b.get("turnUuid")) for b in h.turn_bodies()] == [("running", "tu-9"), ("ended", "tu-9")]


def test_comment_added_reply_is_consumed_without_pending_turn(hermes, tmp_path, monkeypatch):
    h = ApprovalHarness(hermes, tmp_path, monkeypatch)

    async def go():
        await h.connect()
        h.comments.append(_comment("cm-1", "deny QWE234", "2026-01-01T00:00:00.000Z"))
        h.notify(notif(uuid="n-1", action="comment_added", entity_type="task", entity_uuid="t-1",
                       createdAt="2026-01-01T00:00:00.050Z"))
        await wait_for(lambda: any("consumed" in r for _, r in h.adapter.router.skipped))
        await h.adapter.disconnect()

    asyncio.run(go())
    assert h.handled == [] and h.turn_bodies() == []


def test_ordinary_mention_still_wakes(hermes, tmp_path, monkeypatch):
    h = ApprovalHarness(hermes, tmp_path, monkeypatch)

    async def go():
        await h.connect()
        h.comments.append(_comment("cm-0", "approve once OLD234", "2026-01-01T00:00:00.000Z"))
        h.comments.insert(0, _comment("cm-1", "@[Hermes](agent:agent-1) please look at this",
                                      "2026-01-01T00:01:00.000Z"))
        h.notify(notif(uuid="n-2", action="mentioned", entity_type="task", entity_uuid="t-1",
                       createdAt="2026-01-01T00:01:00.020Z"))
        await wait_for(lambda: h.handled)
        await h.idle()
        await h.adapter.disconnect()

    asyncio.run(go())
    assert len(h.handled) == 1


def test_replayed_pending_turn_after_reconnect_is_closed_not_run(hermes, tmp_path, monkeypatch):
    """The live SSE event was missed; the reconnect sweep finds the mention's pending turn."""
    h = ApprovalHarness(hermes, tmp_path, monkeypatch)

    async def go():
        h.fake.notifications.append(notif(uuid="n-5", action="mentioned", entity_type="task", entity_uuid="t-1",
                                          createdAt="2026-01-01T00:00:00.100Z"))
        h.comments.append(_comment("cm-5", "approve session ZXC234", "2026-01-01T00:00:00.000Z"))
        h.fake.pending = [{"turnUuid": "tu-5", "sessionId": "i-1", "directIdeaUuid": "i-1",
                           "trigger": "mentioned"}]
        await h.connect()
        await wait_for(lambda: len(h.turn_bodies()) == 2)
        await h.adapter.disconnect()

    asyncio.run(go())
    assert h.handled == []
    assert [(b["status"], b.get("turnUuid")) for b in h.turn_bodies()] == [("running", "tu-5"), ("ended", "tu-5")]


def test_pending_turn_closed_even_if_live_copy_was_already_seen(hermes, tmp_path, monkeypatch):
    h = ApprovalHarness(hermes, tmp_path, monkeypatch)
    monkeypatch.setattr(approval, "PENDING_TURN_RETRIES", 1)

    async def go():
        await h.connect()
        h.comments.append(_comment("cm-6", "deny RTY234", "2026-01-01T00:00:00.000Z"))
        h.notify(notif(uuid="n-6", action="mentioned", entity_type="task", entity_uuid="t-1",
                       createdAt="2026-01-01T00:00:00.100Z"))
        await wait_for(lambda: any("consumed" in r for _, r in h.adapter.router.skipped))
        await asyncio.sleep(0.05)  # live close found no pending turn yet
        h.fake.pending = [{"turnUuid": "tu-6", "sessionId": "i-1", "directIdeaUuid": "i-1",
                           "trigger": "mentioned"}]
        h.fake.feed.event({"type": "control", "command": "deliver_turn", "targetConnectionUuid": "c-1",
                           "turnUuid": "tu-6"})
        await wait_for(lambda: len(h.turn_bodies()) == 2)
        await h.adapter.disconnect()

    asyncio.run(go())
    assert h.handled == []
    assert [(b["status"], b.get("turnUuid")) for b in h.turn_bodies()] == [("running", "tu-6"), ("ended", "tu-6")]


def test_close_keeps_running_execution_row(hermes, tmp_path, monkeypatch):
    """Closing the reply's pending turn must not drop the execution row of the waiting turn."""
    h = ApprovalHarness(hermes, tmp_path, monkeypatch)

    async def go():
        await h.connect()
        h.adapter.turns.executions["task:t-1"] = {"entityType": "task", "entityUuid": "t-1", "status": "running"}
        f = approval.ReplyFilter(h.adapter, h.adapter.router)
        await f._close("tu-1", "i-1", "task", "t-1")
        assert "task:t-1" in h.adapter.turns.executions
        h.adapter.turns.executions.clear()
        await h.adapter.disconnect()

    asyncio.run(go())
    assert all("entityType" not in b for b in h.turn_bodies())
