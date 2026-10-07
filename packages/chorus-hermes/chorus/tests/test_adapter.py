"""adapter.py against a fake Hermes gateway (``gateway.*`` modules injected) and a fake Chorus."""

from __future__ import annotations

import asyncio
import enum
import os
import sys
import types
from dataclasses import dataclass, field
from typing import Any, Dict, Optional

import httpx
import pytest

from .fixtures.chorus_fake import FakeChorus, wait_for

ENV = {"CHORUS_URL": "https://chorus.test", "CHORUS_API_KEY": "cho_test"}


# -- fake Hermes gateway -----------------------------------------------------------------


class ProcessingOutcome(enum.Enum):
    SUCCESS = "success"
    FAILURE = "failure"
    CANCELLED = "cancelled"


class MessageType(enum.Enum):
    TEXT = "text"


@dataclass
class MessageEvent:
    text: str
    message_type: Any = MessageType.TEXT
    source: Any = None
    message_id: Optional[str] = None
    raw_message: Any = None
    allow_gateway_control: bool = True
    metadata: Dict[str, Any] = field(default_factory=dict)
    _gateway_accepted: bool = False


@dataclass
class SendResult:
    success: bool
    message_id: Optional[str] = None
    error: Optional[str] = None


@dataclass
class PlatformConfig:
    extra: Dict[str, Any] = field(default_factory=dict)


class Platform:
    def __init__(self, value):
        self.value = value


class FakeBase:
    """Just enough of BasePlatformAdapter: session guard, background turn, outcome hooks, /stop."""

    def __init__(self, config, platform):
        self.config, self.platform = config, platform
        self._message_handler = None
        self._active_sessions: Dict[str, Any] = {}
        self._session_tasks: Dict[str, asyncio.Task] = {}
        self._expected_cancelled: set = set()
        self.fatal = None
        self.connected = False
        self.busy_events = []
        self.started_events = []
        self.outcomes = []

    def set_message_handler(self, handler):
        self._message_handler = handler

    def _set_fatal_error(self, code, message, *, retryable):
        self.fatal = (code, message, retryable)

    def _mark_connected(self):
        self.connected = True

    def _mark_disconnected(self):
        self.connected = False

    def build_source(self, chat_id, chat_name=None, chat_type="dm", user_id=None, user_name=None, **kw):
        return types.SimpleNamespace(platform=self.platform, chat_id=chat_id, chat_name=chat_name,
                                     chat_type=chat_type, user_id=user_id, user_name=user_name)

    def _source_session_key(self, source):
        return f"agent:main:chorus:dm:{source.chat_id}"

    async def handle_message(self, event):
        key = self._source_session_key(event.source)
        if key in self._active_sessions:
            if event.allow_gateway_control and event.text == "/stop":
                await self.send(event.source.chat_id, "Stopped.", metadata={"notify": True})
                await self.cancel_session_processing(key)
                return
            self.busy_events.append(event)
            return
        self._active_sessions[key] = True
        self.started_events.append(event)
        self._session_tasks[key] = asyncio.ensure_future(self._process(event, key))
        event._gateway_accepted = True

    async def _process(self, event, key):
        try:
            await self.on_processing_start(event)
            response = await self._message_handler(event)
            ok = True
            if response:
                ok = (await self.send(event.source.chat_id, response, metadata={"notify": True})).success
            self.outcomes.append(ProcessingOutcome.SUCCESS if ok else ProcessingOutcome.FAILURE)
            await self.on_processing_complete(event, self.outcomes[-1])
        except asyncio.CancelledError:
            expected = asyncio.current_task() in self._expected_cancelled
            self.outcomes.append(ProcessingOutcome.CANCELLED if expected else ProcessingOutcome.FAILURE)
            await self.on_processing_complete(event, self.outcomes[-1])
            raise
        except Exception as exc:
            self.outcomes.append(ProcessingOutcome.FAILURE)
            await self.on_processing_complete(event, ProcessingOutcome.FAILURE)
            await self.send(event.source.chat_id, f"warning: {exc}", metadata={})
        finally:
            await asyncio.sleep(0.01)  # base cleanup happens after the completion hook
            self._active_sessions.pop(key, None)
            self._session_tasks.pop(key, None)

    async def cancel_session_processing(self, key, **kw):
        task = self._session_tasks.pop(key, None)
        if task and not task.done():
            self._expected_cancelled.add(task)
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)


def gateway_authorizes(adapter, user_id, env) -> bool:
    """authz_mixin semantics: env allowlist wins; else the adapter's extra["allow_from"]."""
    raw = env.get("CHORUS_ALLOWED_USERS", "")
    if raw.strip():
        return user_id in {u.strip() for u in raw.split(",")}
    return user_id in set(adapter.config.extra.get("allow_from") or [])


@pytest.fixture
def hermes(monkeypatch):
    mods = {
        "gateway": types.ModuleType("gateway"),
        "gateway.config": types.ModuleType("gateway.config"),
        "gateway.platforms": types.ModuleType("gateway.platforms"),
        "gateway.platforms.base": types.ModuleType("gateway.platforms.base"),
        "gateway.platforms.event": types.ModuleType("gateway.platforms.event"),
    }
    mods["gateway.config"].Platform = Platform
    mods["gateway.config"].PlatformConfig = PlatformConfig
    mods["gateway.platforms.base"].BasePlatformAdapter = FakeBase
    mods["gateway.platforms.base"].SendResult = SendResult
    ev = mods["gateway.platforms.event"]
    ev.MessageEvent, ev.MessageType, ev.ProcessingOutcome = MessageEvent, MessageType, ProcessingOutcome
    for name, mod in mods.items():
        monkeypatch.setitem(sys.modules, name, mod)
    from chorus_hermes import adapter as adapter_mod
    monkeypatch.setattr(adapter_mod, "_ADAPTER_CLASS", None)
    return adapter_mod


class Harness:
    def __init__(self, adapter_mod, tmp_path, env=None, cwd: Any = "repo", handler=None):
        self.mod = adapter_mod
        self.fake = FakeChorus()
        self.env = dict(ENV if env is None else env)
        if cwd == "repo":
            (tmp_path / "repo").mkdir(exist_ok=True)
            cwd = str(tmp_path / "repo")
        self.delays = []
        self.adapter = adapter_mod.create_adapter(
            PlatformConfig(), env=self.env, hermes_config={"terminal": {"cwd": cwd}},
            transport=httpx.MockTransport(self.fake),
            sse_options={"sleep": self._sleep, "host": "box"})
        self.rejected = []
        self.handled = []
        self.reply = "final answer"
        self.gate: Optional[asyncio.Event] = None
        self.raise_exc: Optional[Exception] = None
        self.adapter.set_message_handler(handler or self._handler)

    async def _sleep(self, d):
        self.delays.append(d)
        await asyncio.sleep(0)

    async def _handler(self, event):
        if not gateway_authorizes(self.adapter, event.source.user_id, self.env):
            self.rejected.append(event)
            return None
        self.handled.append(event)
        if self.gate is not None:
            await self.gate.wait()
        if self.raise_exc is not None:
            raise self.raise_exc
        return self.reply

    async def connect(self, register=True):
        ok = await self.adapter.connect()
        if ok and register:
            await wait_for(lambda: self.fake.feeds)
            self.fake.feed.event({"type": "connection_registered", "connectionUuid": "c-1",
                                  "connectedAt": "2026-01-01T00:00:00.000Z"})
            await wait_for(lambda: self.adapter.connection_uuid == "c-1")
        return ok

    def notify(self, n, **transport):
        self.fake.notifications.append(n)
        self.fake.feed.event({"type": "new_notification", "notificationUuid": n["uuid"], **transport})

    def turn_bodies(self):
        return self.fake.bodies("/api/daemon/turn-advance")

    async def idle(self):
        await wait_for(lambda: not self.adapter._active and not self.adapter._queues
                       and not self.adapter._session_tasks, timeout=3)
        await asyncio.sleep(0.02)


def notif(uuid="n-1", action="mentioned", entity_type="idea", entity_uuid="i-1", **kw):
    base = {"uuid": uuid, "action": action, "projectUuid": "p-1", "entityType": entity_type,
            "entityUuid": entity_uuid, "entityTitle": "Idea One", "message": "hi", "actorType": "user",
            "actorUuid": "owner-1", "actorName": "Felix"}
    base.update(kw)
    return base


def run(coro):
    return asyncio.run(coro)


# -- tests ---------------------------------------------------------------------------------


def test_register_platform_and_hooks(hermes, fake_ctx):
    hermes.register(fake_ctx)
    entry = fake_ctx.platforms["chorus"]
    assert entry["allowed_users_env"] == "CHORUS_ALLOWED_USERS"
    assert entry["required_env"] == ["CHORUS_URL", "CHORUS_API_KEY"]
    assert callable(entry["is_connected"]) and entry["check_fn"]() is True
    assert set(fake_ctx.hooks) == {"pre_llm_call", "post_api_request", "api_request_error", "agent_loop_stopped"}
    adapter = entry["adapter_factory"](PlatformConfig())
    assert type(adapter).__name__ == "ChorusPlatformAdapter" and isinstance(adapter, FakeBase)


def test_register_declares_provides_hooks():
    import yaml

    from .conftest import PLUGIN_DIR
    from chorus_hermes import adapter

    declared = set(yaml.safe_load((PLUGIN_DIR / "plugin.yaml").read_text())["provides_hooks"])
    assert set(adapter.HOOKS) <= declared


@pytest.mark.parametrize("cwd", [None, ".", "auto", "/definitely/not/a/dir"])
def test_refuses_to_connect_without_terminal_cwd(hermes, tmp_path, cwd):
    h = Harness(hermes, tmp_path, cwd=cwd)
    assert run(h.connect()) is False
    code, message, retryable = h.adapter.fatal
    assert code == "chorus_cwd_unset" and "terminal.cwd" in message and retryable is False
    assert h.fake.calls == []


def test_refuses_without_credentials(hermes, tmp_path):
    h = Harness(hermes, tmp_path, env={})
    assert run(h.connect()) is False
    assert h.adapter.fatal[0] == "chorus_config"


def test_reports_realpath_cwd_and_seeds_allowlist(hermes, tmp_path):
    real = tmp_path / "real"
    real.mkdir()
    link = tmp_path / "link"
    os.symlink(real, link)
    h = Harness(hermes, tmp_path, cwd=str(link))

    async def go():
        assert await h.connect()
        await h.adapter.disconnect()

    run(go())
    sse = [c for c in h.fake.calls if c[1] == "/api/events/notifications"][0]
    assert sse[2]["cwd"] == os.path.realpath(link) == str(real.resolve())
    assert sse[2]["clientType"] == "hermes" and sse[2]["host"] == "box" and sse[2]["livenessAck"] == "v1"
    assert h.adapter.config.extra["allow_from"] == ["owner-1"]


def test_wake_runs_with_owner_user_id_without_allowlist_env(hermes, tmp_path):
    h = Harness(hermes, tmp_path)
    h.fake.lineage["idea:i-1"] = ("i-1", "i-1")

    async def go():
        await h.connect()
        h.notify(notif())
        await wait_for(lambda: h.adapter.started_events)
        await h.idle()
        await h.adapter.disconnect()

    run(go())
    assert "CHORUS_ALLOWED_USERS" not in h.env
    assert h.rejected == [] and len(h.handled) == 1
    event = h.handled[0]
    assert event.source.user_id == "owner-1" and event.source.chat_id == "idea:i-1"
    assert event.allow_gateway_control is False
    assert event.text.startswith("[Headless daemon session]")


def test_env_allowlist_without_owner_rejects(hermes, tmp_path):
    """Sanity check of the fake: an operator allowlist replaces the seeded list."""
    h = Harness(hermes, tmp_path, env={**ENV, "CHORUS_ALLOWED_USERS": "someone-else"})

    async def go():
        await h.connect()
        h.notify(notif())
        await wait_for(lambda: h.rejected)
        await h.idle()
        await h.adapter.disconnect()

    run(go())
    assert len(h.rejected) == 1


def test_turn_reporting_order_and_send_writes_transcript_only(hermes, tmp_path):
    h = Harness(hermes, tmp_path)
    h.fake.lineage["idea:i-1"] = ("i-1", "i-1")

    async def go():
        await h.connect()
        h.notify(notif())
        await wait_for(lambda: h.adapter.started_events)
        await h.idle()
        # a send outside any turn, and a non-final send, are not recorded
        await h.adapter.send("idea:i-1", "late", metadata={"notify": True})
        await h.adapter.disconnect()

    run(go())
    seq = [p for p in h.fake.paths() if p.startswith("/api/daemon/") and p != "/api/daemon/pending-turns"]
    assert seq == ["/api/daemon/turn-advance", "/api/daemon/execution-state", "/api/daemon/transcript",
                   "/api/daemon/transcript", "/api/daemon/turn-advance", "/api/daemon/execution-state"]
    running, ended = h.turn_bodies()
    assert running["status"] == "running" and running["sessionId"] == "i-1"
    assert ended == {"connectionUuid": "c-1", "sessionId": "i-1", "status": "ended", "turnUuid": "turn-1",
                     "entityType": "idea", "entityUuid": "i-1"}
    user, assistant = h.fake.bodies("/api/daemon/transcript")
    assert user["messages"][0]["role"] == "user" and user["messages"][0]["text"].startswith("[Chorus] You were")
    assert assistant == {"messages": [{"role": "assistant", "text": "final answer"}], "turnUuid": "turn-1"}
    assert not any("comment" in p for p in h.fake.paths())
    assert h.fake.tool_calls("chorus_add_comment") == []


def test_non_final_sends_are_not_transcribed(hermes, tmp_path):
    h = Harness(hermes, tmp_path)

    async def handler(event):
        await h.adapter.send(event.source.chat_id, "tool progress", metadata={})
        await h.adapter.send(event.source.chat_id, "interim", metadata={"notify": True, "_interim_send": True})
        return "the end"

    h.adapter.set_message_handler(handler)

    async def go():
        await h.connect()
        h.notify(notif())
        await wait_for(lambda: h.adapter.started_events)
        await h.idle()
        await h.adapter.disconnect()

    run(go())
    texts = [b["messages"][0]["text"] for b in h.fake.bodies("/api/daemon/transcript")]
    assert texts[1:] == ["the end"]


def test_human_instruction_prompt_not_duplicated_in_transcript(hermes, tmp_path):
    h = Harness(hermes, tmp_path)
    h.fake.pending = [{"turnUuid": "tu-1", "sessionId": "i-1", "directIdeaUuid": "i-1",
                       "trigger": "human_instruction", "promptText": "please rebase"}]

    async def go():
        await h.connect()
        await wait_for(lambda: h.adapter.started_events)
        await h.idle()
        await h.adapter.disconnect()

    run(go())
    assert h.turn_bodies()[0]["turnUuid"] == "tu-1"
    assert [b["messages"][0]["role"] for b in h.fake.bodies("/api/daemon/transcript")] == ["assistant"]
    assert "please rebase" in h.adapter.started_events[0].text


def test_two_wakes_for_one_idea_share_a_session_sequentially(hermes, tmp_path):
    h = Harness(hermes, tmp_path)
    h.fake.lineage["task:t-1"] = ("i-1", "i-1")
    h.fake.lineage["task:t-2"] = ("i-1", "i-1")
    h.gate = asyncio.Event() if False else None

    async def go():
        h.gate = asyncio.Event()
        await h.connect()
        h.notify(notif("n-1", action="task_assigned", entity_type="task", entity_uuid="t-1"))
        await wait_for(lambda: len(h.handled) == 1)
        h.notify(notif("n-2", action="task_assigned", entity_type="task", entity_uuid="t-2"))
        await wait_for(lambda: h.adapter._queues.get("idea:i-1"))
        await asyncio.sleep(0.05)
        assert len(h.handled) == 1 and h.adapter.busy_events == []  # queued by the adapter, not the gateway
        queued = h.fake.bodies("/api/daemon/execution-state")[-1]["executions"]
        assert {(e["entityUuid"], e["status"]) for e in queued} == {("t-1", "running"), ("t-2", "queued")}
        h.gate.set()
        await wait_for(lambda: len(h.handled) == 2)
        await h.idle()
        await h.adapter.disconnect()

    run(go())
    keys = {h.adapter._source_session_key(e.source) for e in h.handled}
    assert keys == {"agent:main:chorus:dm:idea:i-1"}
    statuses = [(b["status"], b.get("entityUuid")) for b in h.turn_bodies()]
    assert statuses == [("running", "t-1"), ("ended", "t-1"), ("running", "t-2"), ("ended", "t-2")]


def test_wake_waits_behind_a_hermes_internal_run_instead_of_failing(hermes, tmp_path, monkeypatch):
    """e2e: an async delegate_task follow-up held the chat's gateway session with no Chorus turn;
    the wake was handed to the busy gateway, not accepted, and reported as a false wakeError."""
    monkeypatch.setattr(hermes, "GATEWAY_BUSY_POLL_S", 0.01)
    h = Harness(hermes, tmp_path)

    async def go():
        await h.connect()
        key = "agent:main:chorus:dm:idea:i-1"
        h.adapter._active_sessions[key] = True  # Hermes-internal run owns the session
        h.notify(notif("n-1"))
        await wait_for(lambda: h.adapter._queues.get("idea:i-1"))
        await asyncio.sleep(0.05)
        assert h.handled == [] and h.adapter.busy_events == []  # never handed to the busy gateway
        assert h.adapter.chat_running("idea:i-1") and not h.adapter._active
        h.adapter._active_sessions.pop(key)  # the internal run finished
        await wait_for(lambda: len(h.handled) == 1)
        await h.idle()
        await h.adapter.disconnect()

    run(go())
    statuses = [b["status"] for b in h.turn_bodies()]
    assert statuses == ["running", "ended"]
    assert not any("wakeError" in b for b in h.turn_bodies())


def test_handler_failure_reports_crash(hermes, tmp_path):
    h = Harness(hermes, tmp_path)
    h.raise_exc = RuntimeError("model exploded")

    async def go():
        await h.connect()
        h.notify(notif(entity_type="task", entity_uuid="t-1"))
        await wait_for(lambda: h.adapter.outcomes)
        await h.idle()
        await h.adapter.disconnect()

    run(go())
    terminal = h.turn_bodies()[-1]
    assert terminal["status"] == "interrupted" and terminal["interruptedReason"] == "crash"
    assert terminal["wakeError"]["source"] == "hermes" and len(terminal["wakeError"]["message"]) <= 500
    assert h.fake.bodies("/api/daemon/report-interrupt") == [
        {"connectionUuid": "c-1", "entityType": "task", "entityUuid": "t-1", "reason": "crash"}]
    # the base's error notice after completion is not transcribed
    assert [b["messages"][0]["role"] for b in h.fake.bodies("/api/daemon/transcript")] == ["user"]


def test_provider_error_rendered_as_reply_is_a_crash(hermes, tmp_path):
    h = Harness(hermes, tmp_path)

    async def handler(event):
        hooks = h.mod.HOOKS
        hooks["pre_llm_call"](session_id="hs-1", user_message=event.text, platform="chorus")
        hooks["api_request_error"](session_id="hs-1", error={"type": "APIError", "message": "rate limited " * 80},
                                   status_code=429, platform="chorus")
        return "Sorry, the provider failed."

    h.adapter.set_message_handler(handler)

    async def go():
        await h.connect()
        h.notify(notif())
        await wait_for(lambda: h.adapter.outcomes)
        await h.idle()
        await h.adapter.disconnect()

    run(go())
    assert h.adapter.outcomes == [ProcessingOutcome.SUCCESS]
    terminal = h.turn_bodies()[-1]
    assert terminal["interruptedReason"] == "crash"
    assert terminal["wakeError"]["kind"] == "execution" and "rate limited" in terminal["wakeError"]["message"]
    assert len(terminal["wakeError"]["message"]) <= 500


def test_retried_provider_error_then_success_ends_with_usage(hermes, tmp_path):
    h = Harness(hermes, tmp_path)

    async def handler(event):
        hooks = h.mod.HOOKS
        hooks["pre_llm_call"](session_id="hs-1", user_message=event.text, platform="chorus")
        hooks["api_request_error"](session_id="hs-1", error={"message": "transient"}, platform="chorus")
        hooks["post_api_request"](session_id="hs-1", platform="chorus", response_model="gpt-x",
                                  usage={"input_tokens": 7, "output_tokens": 3, "cache_read_tokens": 1,
                                         "cache_write_tokens": 0})
        hooks["post_api_request"](session_id="hs-other", platform="telegram", usage={"input_tokens": 99})
        return "ok"

    h.adapter.set_message_handler(handler)

    async def go():
        await h.connect()
        h.notify(notif())
        await wait_for(lambda: h.adapter.outcomes)
        mapping = h.mod.session_entity("agent:main:chorus:dm:idea:i-1")
        by_session = h.mod.session_entity(hermes_session_id="hs-1")
        await h.idle()
        await h.adapter.disconnect()
        assert h.mod.session_entity("agent:main:chorus:dm:idea:i-1") is None  # cleared on disconnect
        return mapping, by_session

    mapping, by_session = run(go())
    terminal = h.turn_bodies()[-1]
    assert terminal["status"] == "ended"
    assert terminal["usage"] == {"inputTokens": 7, "outputTokens": 3, "cacheCreationTokens": 0,
                                 "cacheReadTokens": 1, "model": "gpt-x", "source": "hermes"}
    assert mapping["entityType"] == "idea" and mapping["entityUuid"] == "i-1" and mapping["chatId"] == "idea:i-1"
    assert mapping["hermesSessionId"] == "hs-1"
    assert by_session["chatId"] == "idea:i-1"


def test_control_interrupt_cancels_running_turn(hermes, tmp_path):
    h = Harness(hermes, tmp_path)

    async def go():
        h.gate = asyncio.Event()
        await h.connect()
        h.notify(notif(entity_type="task", entity_uuid="t-1"))
        await wait_for(lambda: h.handled)
        h.fake.feed.event({"type": "control", "command": "interrupt", "targetConnectionUuid": "c-other",
                           "entityType": "task", "entityUuid": "t-1"})
        await asyncio.sleep(0.05)
        assert h.adapter.outcomes == []  # not for this connection
        h.fake.feed.event({"type": "control", "command": "interrupt", "targetConnectionUuid": "c-1",
                           "entityType": "task", "entityUuid": "t-1"})
        await wait_for(lambda: h.adapter.outcomes)
        await h.idle()
        await h.adapter.disconnect()

    run(go())
    assert h.adapter.outcomes == [ProcessingOutcome.CANCELLED]
    terminal = h.turn_bodies()[-1]
    assert terminal["status"] == "interrupted" and terminal["interruptedReason"] == "user"
    assert h.fake.bodies("/api/daemon/report-interrupt")[0]["reason"] == "user"
    # the "/stop" acknowledgement is not part of the transcript
    assert [b["messages"][0]["role"] for b in h.fake.bodies("/api/daemon/transcript")] == ["user"]


def test_disconnect_reports_shutdown(hermes, tmp_path):
    h = Harness(hermes, tmp_path)

    async def go():
        h.gate = asyncio.Event()
        await h.connect()
        h.notify(notif())
        await wait_for(lambda: h.handled)
        await h.adapter.disconnect()
        await asyncio.sleep(0.05)

    run(go())
    terminal = h.turn_bodies()[-1]
    assert terminal["status"] == "interrupted" and terminal["interruptedReason"] == "shutdown"
    assert len(h.turn_bodies()) == 2
    assert "/api/daemon/report-interrupt" not in h.fake.paths()
    assert h.fake.bodies("/api/daemon/execution-state")[-1]["executions"] == []
    assert h.adapter.connected is False


def test_sweeps_pending_turns_on_register_and_reconnect(hermes, tmp_path):
    h = Harness(hermes, tmp_path)

    async def go():
        await h.connect()
        await wait_for(lambda: len([c for c in h.fake.calls if c[1] == "/api/daemon/pending-turns"]) == 1)
        h.fake.feed.close()  # stream drops → reconnect
        await wait_for(lambda: len(h.fake.feeds) == 2)
        h.fake.pending = [{"turnUuid": "tu-7", "sessionId": "i-1", "directIdeaUuid": "i-1",
                           "trigger": "human_instruction", "promptText": "continue"}]
        h.fake.feed.event({"type": "connection_registered", "connectionUuid": "c-1", "connectedAt": "z"})
        await wait_for(lambda: h.handled)
        await h.idle()
        await h.adapter.disconnect()

    run(go())
    sweeps = [c for c in h.fake.calls if c[1] == "/api/daemon/pending-turns"]
    assert len(sweeps) == 2 and sweeps[-1][2] == {"connectionUuid": "c-1"}
    assert h.delays == [1.0]
    assert h.turn_bodies()[0]["turnUuid"] == "tu-7"


def test_chat_id_falls_back_to_entity_without_direct_idea(hermes, tmp_path):
    h = Harness(hermes, tmp_path)

    async def go():
        await h.connect()
        h.notify(notif(action="task_assigned", entity_type="task", entity_uuid="t-9"))
        await wait_for(lambda: h.handled)
        await h.idle()
        await h.adapter.disconnect()

    run(go())
    assert h.handled[0].source.chat_id == "task:t-9"
    assert h.turn_bodies()[0]["sessionId"] == "t-9"


def test_client_version_comes_from_plugin_yaml_without_pyyaml(hermes, monkeypatch):
    import yaml as real_yaml

    from .conftest import PLUGIN_DIR

    monkeypatch.setitem(sys.modules, "yaml", None)  # the Hermes runtime has no PyYAML
    expected = str(real_yaml.safe_load((PLUGIN_DIR / "plugin.yaml").read_text())["version"])
    assert hermes._client_version() == expected != "0.0.0"


# -- admission (B2-start-without-admission; Leo's round-2 repro) ------------------------------


def _pending_wake(hermes_router, turn_uuid="already-ended"):
    return hermes_router.WakeRequest(
        source="pending_turn", notification=notif("n-A", entity_uuid="idea-A"), label=f"turn:{turn_uuid}",
        entity_type="idea", entity_uuid="idea-A", direct_idea_uuid="idea-A", root_idea_uuid="idea-A",
        turn_uuid=turn_uuid, prompt="[Chorus] You were mentioned", canonical_session_id="idea-A")


def _network_down(body):
    raise httpx.ConnectError("connection refused")


ADMISSION_FAILURES = {
    "409": (lambda body: _fake_error(409, "Invalid turn transition ended → running"), "rejected"),
    "404": (lambda body: _fake_error(404, "Turn not found"), "rejected"),
    "network": (_network_down, "unavailable"),
    "503": (lambda body: _fake_error(503, "Service Unavailable"), "unavailable"),
}


def _fake_error(status, message):
    from .fixtures.chorus_fake import error

    return error(status, message)


@pytest.mark.parametrize("case", sorted(ADMISSION_FAILURES))
def test_failed_admission_never_runs_the_model(hermes, tmp_path, case):
    """turn-advance running refused (404/409) or unavailable (network/5xx): no handle_message, no
    transcript, no running execution row, and no terminal report that could end another consumer's turn."""
    from chorus_hermes import router as router_mod

    hook, expected = ADMISSION_FAILURES[case]
    h = Harness(hermes, tmp_path)

    async def go():
        await h.connect()
        await h.idle()
        h.fake.turn_advance_hook = hook
        h.adapter.router.seen.add("turn:already-ended")  # as the router does before dispatching
        await h.adapter.dispatch(_pending_wake(router_mod))
        await h.idle()
        released = "turn:already-ended" not in h.adapter.router.seen
        await h.adapter.disconnect()
        return released

    released = run(go())
    assert h.handled == [] and h.adapter.started_events == []
    assert h.fake.bodies("/api/daemon/transcript") == []
    assert [b["status"] for b in h.turn_bodies()] == ["running"]  # the refused admission only
    assert not any(e["status"] == "running" for b in h.fake.bodies("/api/daemon/execution-state")
                   for e in b["executions"])
    assert h.fake.bodies("/api/daemon/report-interrupt") == []
    # unavailable → released for a later sweep / deliver_turn; rejected → stays handled (dropped)
    assert released is (expected == "unavailable")


def test_rejected_live_wake_is_dropped_without_ending_the_other_consumers_turn(hermes, tmp_path):
    h = Harness(hermes, tmp_path)
    h.fake.lineage["idea:i-1"] = ("i-1", "i-1")

    async def go():
        await h.connect()
        h.fake.turn_advance_hook = lambda body: _fake_error(409, "Invalid turn transition running → running")
        h.notify(notif())
        await wait_for(lambda: h.turn_bodies())
        await h.idle()
        await h.adapter.disconnect()

    run(go())
    assert h.handled == [] and [b["status"] for b in h.turn_bodies()] == ["running"]
    assert h.fake.bodies("/api/daemon/transcript") == []


def test_unavailable_admission_is_retried_by_the_next_sweep(hermes, tmp_path):
    h = Harness(hermes, tmp_path)
    h.fake.pending = [{"turnUuid": "tu-9", "sessionId": "i-1", "directIdeaUuid": "i-1",
                       "trigger": "human_instruction", "promptText": "continue please"}]
    attempts = []

    def flaky(body):
        attempts.append(body["status"])
        return _fake_error(503, "Service Unavailable") if len(attempts) == 1 else None

    h.fake.turn_advance_hook = flaky

    async def go():
        await h.connect()
        await wait_for(lambda: attempts)
        await h.idle()
        assert h.handled == []
        h.fake.feed.event({"type": "control", "command": "deliver_turn", "targetConnectionUuid": "c-1",
                           "turnUuid": "tu-9"})
        await wait_for(lambda: h.handled)
        await h.idle()
        # admitted and done: a further sweep does not run it again
        h.fake.feed.event({"type": "control", "command": "deliver_turn", "targetConnectionUuid": "c-1",
                           "turnUuid": "tu-9"})
        await asyncio.sleep(0.05)
        await h.idle()
        await h.adapter.disconnect()

    run(go())
    assert len(h.handled) == 1
    assert [(b["status"], b.get("turnUuid")) for b in h.turn_bodies()] == [
        ("running", "tu-9"), ("running", "tu-9"), ("ended", "tu-9")]


# -- interrupt → Resume against the server's real admission contract (B4-resume-without-pending-turn) --

def _strict_admission(fake, pending):
    """Mirror advanceTurnForWake: → running admits the given pending turn uuid, or the oldest pending
    one when no uuid is sent; anything else is 404. Admitted turns leave ``pending``."""
    def hook(body):
        if body.get("status") != "running":
            return None
        uuid = body.get("turnUuid") or (pending[0] if pending else None)
        if uuid not in pending:
            return _fake_error(404, "Turn not found")
        pending.remove(uuid)
        from .fixtures.chorus_fake import envelope
        return envelope({"turn": {"uuid": uuid, "status": "running"}})
    fake.turn_advance_hook = hook


@pytest.mark.parametrize("server_turn", [True, False])
def test_resume_after_interrupt_runs_only_with_a_continuation_turn(hermes, tmp_path, server_turn):
    h = Harness(hermes, tmp_path)
    pending = ["turn-live"]
    _strict_admission(h.fake, pending)
    h.fake.lineage["task:t-1"] = ("i-1", "i-1")

    async def go():
        h.gate = asyncio.Event()
        await h.connect()
        h.notify(notif(entity_type="task", entity_uuid="t-1"))
        await wait_for(lambda: h.handled)
        h.fake.feed.event({"type": "control", "command": "interrupt", "targetConnectionUuid": "c-1",
                           "entityType": "task", "entityUuid": "t-1"})
        await wait_for(lambda: h.adapter.outcomes)
        await h.idle()
        runs_before = len(h.handled)
        h.gate.set()
        resume = {"type": "control", "command": "resume", "targetConnectionUuid": "c-1",
                  "entityType": "task", "entityUuid": "t-1", "resumeReason": "user"}
        if server_turn:
            pending.append("turn-resume")  # what POST /api/daemon/resume now creates for hermes
            resume["turnUuid"] = "turn-resume"
        h.fake.feed.event(resume)
        if server_turn:
            await wait_for(lambda: len(h.handled) > runs_before)
        else:
            await asyncio.sleep(0.1)
        await h.idle()
        await h.adapter.disconnect()
        return runs_before

    runs_before = run(go())
    admitted = [b.get("turnUuid") for b in h.turn_bodies() if b["status"] == "running"]
    if server_turn:
        assert len(h.handled) == runs_before + 1
        assert admitted[-1] == "turn-resume" and pending == []
        assert [b["status"] for b in h.turn_bodies() if b.get("turnUuid") == "turn-resume"][-1] == "ended"
    else:
        # admission stays a hard gate: no continuation turn → the model never runs again
        assert len(h.handled) == runs_before
