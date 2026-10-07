"""``chorus`` gateway platform: a Chorus daemon connection inside ``hermes gateway``.

``register(ctx)`` calls ``ctx.register_platform("chorus", ...)`` and registers the
observer hooks the adapter needs (session binding, token usage, provider errors,
interrupt reasons). The adapter class is built lazily from Hermes'
``BasePlatformAdapter`` so this module imports without Hermes (tests inject fakes).

Flow (see ``openspec/changes/add-hermes-plugin/design.md`` "Gateway scheduling"):

    connect()  → chorus_checkin (owner uuid → extra["allow_from"]) → SSE loop
    SSE        → router → dispatch(wake)  [per-chat FIFO: one Hermes turn per chat at a time]
    dispatch   → turn-advance running (ADMISSION: nothing below runs unless the server admits the
                 turn — rejected (4xx) drops the wake, unavailable (network/5xx) releases it for
                 a later sweep / deliver_turn)
               → execution-state → transcript(user)
               → handle_message(MessageEvent(chat_id=idea:<uuid>, user_id=<owner uuid>))
    send()     → transcript(assistant) only — never a Chorus comment
    on_processing_complete(outcome) → terminal turn-advance (+ report-interrupt) → next queued wake

Session mapping for other features (approval transport): :func:`session_entity` maps a
Hermes ``session_key`` (or a Hermes ``session_id`` seen in hooks) back to the Chorus entity.
"""

from __future__ import annotations

import asyncio
import collections
import logging
import uuid as uuidlib
import weakref
from dataclasses import dataclass, field
from types import SimpleNamespace
from typing import Any, Callable, Deque, Dict, List, Mapping, Optional

from . import config as chorus_config
from .mcp_client import ChorusMcpClient
from .prompts import HEADLESS_PREAMBLE
from .rest import ChorusRest
from .router import EventRouter, LineageResolver, WakeRequest, entity_for_chat_id, spawn
from .sse import Registration, SseClient
from .turns import TurnRecord, TurnReporter, entity_of

logger = logging.getLogger(__name__)

PLATFORM_NAME = "chorus"
PLATFORM_LABEL = "Chorus"
DRAIN_WAIT_S = 30.0
# A Hermes-internal run (e.g. the ``[ASYNC DELEGATION BATCH COMPLETE]`` follow-up an async
# ``delegate_task`` injects) can hold the chat's gateway session without any Chorus turn.
# Wakes wait behind it this long (polling every GATEWAY_BUSY_POLL_S) before starting anyway.
GATEWAY_BUSY_WAIT_S = 3600.0
GATEWAY_BUSY_POLL_S = 0.5
STOP_GRACE_S = 10.0

PLATFORM_HINT = (
    "You are running as a Chorus agent woken by the Chorus platform (AI-DLC). Each message on this "
    "channel is a Chorus wake (an assignment, @mention, lifecycle event or a human instruction). "
    "Nobody reads your final reply as a chat message: it is only stored in the Chorus session "
    "transcript. To communicate with humans or other agents, call the Chorus MCP tools explicitly "
    "(e.g. chorus_add_comment with an @mention, elaboration rounds). Never wait for a synchronous reply."
)

# Live adapters (normally one); hooks look turns up here.
_ADAPTERS: "weakref.WeakSet" = weakref.WeakSet()
# ``fn(adapter, router)`` called on every connect once the router exists (approval transport filter).
_ROUTER_SETUP: List[Callable[[Any, EventRouter], None]] = []


def on_router_created(fn: Callable[[Any, EventRouter], None]) -> None:
    """Register ``fn(adapter, router)`` to run whenever an adapter builds its event router."""
    if fn not in _ROUTER_SETUP:
        _ROUTER_SETUP.append(fn)


def _hermes() -> SimpleNamespace:
    """Hermes gateway types, imported lazily (tests install fakes in ``sys.modules``)."""
    from gateway.config import Platform  # type: ignore[import-not-found]
    from gateway.platforms.base import BasePlatformAdapter, SendResult  # type: ignore[import-not-found]
    from gateway.platforms.event import MessageEvent, MessageType, ProcessingOutcome  # type: ignore

    return SimpleNamespace(Platform=Platform, BasePlatformAdapter=BasePlatformAdapter, SendResult=SendResult,
                           MessageEvent=MessageEvent, MessageType=MessageType,
                           ProcessingOutcome=ProcessingOutcome)


def _client_version() -> str:
    """``version:`` from plugin.yaml (line parse: the Hermes runtime ships without PyYAML)."""
    import re
    from pathlib import Path

    try:
        text = (Path(__file__).resolve().parents[1] / "plugin.yaml").read_text(encoding="utf-8")
    except OSError:
        return "0.0.0"
    match = re.search(r"^version:\s*[\"']?([^\"'\s#]+)", text, re.MULTILINE)
    return match.group(1) if match else "0.0.0"


@dataclass
class ActiveTurn:
    wake: WakeRequest
    record: TurnRecord
    chat_id: str
    event: Any = None
    session_key: Optional[str] = None
    dispatched: bool = False
    interrupting: bool = False
    shutdown: bool = False
    api_error: Optional[str] = None
    hermes_session_ids: set = field(default_factory=set)


class ChorusAdapterCore:
    """Chorus behaviour mixed in front of Hermes' ``BasePlatformAdapter``."""

    def __init__(self, config: Any, *, env: Optional[Mapping[str, str]] = None,
                 hermes_config: Optional[Mapping[str, Any]] = None,
                 transport: Any = None, sse_options: Optional[Dict[str, Any]] = None) -> None:
        self._h = _hermes()
        super().__init__(config=config, platform=self._h.Platform(PLATFORM_NAME))  # type: ignore[call-arg]
        if getattr(self.config, "extra", None) is None:
            self.config.extra = {}
        self._env = env
        self._hermes_config = hermes_config
        self._transport = transport  # httpx.MockTransport in tests
        self._sse_options = dict(sse_options or {})
        self.chorus_cfg: Optional[chorus_config.ChorusConfig] = None
        self.cwd: Optional[str] = None
        self.owner_uuid: Optional[str] = None
        self.owner_name: Optional[str] = None
        self.agent_uuid: Optional[str] = None
        self.rest: Optional[ChorusRest] = None
        self.mcp: Optional[ChorusMcpClient] = None
        self.turns: Optional[TurnReporter] = None
        self.router: Optional[EventRouter] = None
        self.sse: Optional[SseClient] = None
        self._sse_task: Optional[asyncio.Task] = None
        self._bg: set = set()
        self._active: Dict[str, ActiveTurn] = {}
        self._queues: Dict[str, Deque[WakeRequest]] = collections.defaultdict(collections.deque)
        self._starting: set = set()
        self._gateway_waiters: set = set()  # chat ids with a wait-for-gateway-release drainer
        self.session_keys: Dict[str, Dict[str, Any]] = {}  # session_key -> Chorus entity mapping
        self._hermes_session_to_chat: Dict[str, str] = {}
        self._connection_uuid: Optional[str] = None

    # -- identity --------------------------------------------------------------------

    @property
    def connection_uuid(self) -> Optional[str]:
        """The last registered connection (kept through shutdown so final reports still attribute)."""
        return self._connection_uuid

    def _get_connection_uuid(self) -> Optional[str]:
        return self.connection_uuid

    # -- connect / disconnect ----------------------------------------------------------

    async def connect(self, *, is_reconnect: bool = False) -> bool:
        try:
            self.chorus_cfg = chorus_config.load_config(self._env)
        except chorus_config.ConfigError as exc:
            logger.error("[Chorus] gateway platform not started: %s (set CHORUS_URL and CHORUS_API_KEY)", exc)
            self._set_fatal_error("chorus_config", str(exc), retryable=False)
            return False
        if self._hermes_config is not None:
            self.cwd = chorus_config.terminal_cwd(self._hermes_config)
        else:
            self.cwd = chorus_config.terminal_cwd()
        if not self.cwd:
            message = ("terminal.cwd is not set (or is a placeholder / not a directory). Set it to the repository "
                       "this gateway serves, e.g. `hermes config set terminal.cwd /path/to/repo`, then restart "
                       "the gateway. Refusing to report $HOME to Chorus.")
            logger.error("[Chorus] gateway platform not started: %s", message)
            self._set_fatal_error("chorus_cwd_unset", message, retryable=False)
            return False

        cfg = self.chorus_cfg
        self.rest = ChorusRest(cfg, async_transport=self._transport)
        self.mcp = ChorusMcpClient(cfg, async_transport=self._transport)
        try:
            checkin = await self.mcp.acall_tool("chorus_checkin", {})
        except Exception as exc:
            logger.error("[Chorus] chorus_checkin failed; cannot resolve the agent owner: %s", type(exc).__name__)
            self._set_fatal_error("chorus_checkin", "chorus_checkin failed", retryable=True)
            return False
        agent = checkin.get("agent") if isinstance(checkin, Mapping) else None
        owner = agent.get("owner") if isinstance(agent, Mapping) else None
        if not isinstance(owner, Mapping) or not isinstance(owner.get("uuid"), str):
            logger.error("[Chorus] this Chorus agent has no owner; wakes cannot be authorised")
            self._set_fatal_error("chorus_no_owner", "Chorus agent has no owner", retryable=False)
            return False
        self.owner_uuid = owner["uuid"]
        self.owner_name = owner.get("name") if isinstance(owner.get("name"), str) else None
        self.agent_uuid = agent.get("uuid") if isinstance(agent.get("uuid"), str) else None
        self._seed_allowlist()
        _ADAPTERS.add(self)

        self.turns = TurnReporter(self.rest, self._get_connection_uuid, secrets=(cfg.api_key,))
        self.router = EventRouter(mcp=self.mcp, lineage=LineageResolver(self.rest), dispatch=self.dispatch,
                                  get_connection_uuid=self._get_connection_uuid,
                                  pending_turns=self.turns.pending_turns)
        self.router.control_hooks.update(is_running=self.is_entity_running, interrupt=self.interrupt_entity)
        for setup in list(_ROUTER_SETUP):
            try:
                setup(self, self.router)
            except Exception:
                logger.exception("[Chorus] router setup callback failed")
        self.sse = SseClient(
            cfg, cwd=self.cwd, client_version=_client_version(), on_event=self._on_sse_event,
            on_control=self._on_sse_control, on_conflict=self._on_conflict, on_registered=self._on_registered,
            ack_heartbeat=lambda reg: self.turns.heartbeat(reg.connection_uuid, reg.connected_at),
            transport=self._transport, **self._sse_options)
        self._sse_task = asyncio.ensure_future(self.sse.run())
        self._mark_connected()
        logger.info("[Chorus] gateway platform connected (cwd=%s)", self.cwd)
        return True

    def _seed_allowlist(self) -> None:
        """Authorise our own events: the gateway accepts senders in ``extra["allow_from"]``."""
        extra = self.config.extra
        allow = extra.get("allow_from")
        current = [str(a) for a in allow] if isinstance(allow, (list, tuple, set)) else (
            [a.strip() for a in allow.split(",") if a.strip()] if isinstance(allow, str) else [])
        if self.owner_uuid not in current:
            current.append(self.owner_uuid)
        extra["allow_from"] = current

    async def disconnect(self) -> None:
        if self.sse is not None:
            self.sse.stop()  # no more events; the stream itself is closed after the final reports
        for chat_id, turn in list(self._active.items()):
            turn.shutdown = True
            self._active.pop(chat_id, None)
            if self.turns is not None:
                await self.turns.finish(turn.record, "interrupted", "shutdown")
            if turn.session_key and hasattr(self, "cancel_session_processing"):
                try:
                    await self.cancel_session_processing(turn.session_key)
                except Exception:
                    logger.debug("[Chorus] cancel on shutdown failed", exc_info=True)
        self._queues.clear()
        if self.turns is not None and self.turns.executions:
            self.turns.executions.clear()
            await self.turns.emit_snapshot()
        if self._sse_task is not None:
            self._sse_task.cancel()
            try:
                await self._sse_task
            except BaseException:
                pass
            self._sse_task = None
        for task in list(self._bg):
            task.cancel()
        _ADAPTERS.discard(self)
        self.session_keys.clear()
        self._mark_disconnected()
        logger.info("[Chorus] gateway platform disconnected")

    # -- SSE callbacks -----------------------------------------------------------------

    def _on_registered(self, registration: Registration, reconnect: bool) -> None:
        self._connection_uuid = registration.connection_uuid
        logger.info("[Chorus] registered connection %s%s", registration.connection_uuid,
                    " (reconnect)" if reconnect else "")
        if self.router is not None:
            spawn(self.router.sweep_pending_turns(), self._bg)

    def _on_sse_event(self, event: Mapping[str, Any]) -> None:
        if self.router is not None and event.get("type") == "new_notification":
            spawn(self.router.handle_notification(event), self._bg)

    def _on_sse_control(self, event: Mapping[str, Any]) -> None:
        if self.router is not None:
            spawn(self.router.handle_control(event), self._bg)

    def _on_conflict(self, event: Mapping[str, Any]) -> None:
        self._set_fatal_error(
            "chorus_connection_conflict",
            f"another live Chorus client already serves host={event.get('host')} cwd={event.get('cwd')}",
            retryable=False)

    # -- dispatch ------------------------------------------------------------------------

    def chat_busy(self, chat_id: str) -> bool:
        return chat_id in self._active or chat_id in self._starting or bool(self._queues.get(chat_id))

    def _chat_session_key(self, chat_id: str) -> Optional[str]:
        """The Hermes gateway session key a wake for ``chat_id`` would run under."""
        try:
            source = self.build_source(chat_id=chat_id, chat_name=chat_id, chat_type="dm",
                                       user_id=self.owner_uuid, user_name=self.owner_name or self.owner_uuid)
            return self._source_session_key(source)
        except Exception:
            return None

    def gateway_session_busy(self, chat_id: str) -> bool:
        """True while the Hermes gateway runs this chat's session outside any Chorus turn."""
        key = self._chat_session_key(chat_id)
        return bool(key) and key in (getattr(self, "_active_sessions", None) or {})

    def chat_running(self, chat_id: str) -> bool:
        """An agent run is live in this chat: a Chorus turn, or a Hermes-internal run."""
        return chat_id in self._active or chat_id in self._starting or self.gateway_session_busy(chat_id)

    async def dispatch(self, wake: WakeRequest) -> None:
        """Run a wake now, or queue it behind the running turn of the same chat (FIFO)."""
        chat_id = wake.chat_id
        gateway_busy = not self.chat_busy(chat_id) and self.gateway_session_busy(chat_id)
        if gateway_busy or self.chat_busy(chat_id):
            self._queues[chat_id].append(wake)
            logger.info("[Chorus] wake %s queued behind running %s on %s", wake.label,
                        "Hermes session" if gateway_busy else "turn", chat_id)
            await self.turns.mark_queued(entity_of(wake.entity_type, wake.entity_uuid),
                                         wake.root_idea_uuid, wake.direct_idea_uuid)
            if gateway_busy and chat_id not in self._gateway_waiters:
                # No Chorus turn will finalize and drain this queue: wait for the gateway instead.
                # Handing the wake to the busy gateway would let Hermes' busy-input policy steer /
                # redirect / drop it without accepting it (reported as a false wake failure).
                self._gateway_waiters.add(chat_id)
                spawn(self._drain_after_gateway(chat_id), self._bg)
            return
        await self._start(wake)

    async def _drain_after_gateway(self, chat_id: str) -> None:
        try:
            loop = asyncio.get_running_loop()
            deadline = loop.time() + GATEWAY_BUSY_WAIT_S
            while self.gateway_session_busy(chat_id) and loop.time() < deadline:
                await asyncio.sleep(GATEWAY_BUSY_POLL_S)
        finally:
            self._gateway_waiters.discard(chat_id)
        await self._drain(chat_id, None)

    def _build_event(self, wake: WakeRequest, text: str, *, control: bool = False, message_id: str = ""):
        h = self._h
        title = wake.notification.get("entityTitle") if isinstance(wake.notification, Mapping) else None
        source = self.build_source(
            chat_id=wake.chat_id, chat_name=title if isinstance(title, str) and title else wake.chat_id,
            chat_type="dm", user_id=self.owner_uuid, user_name=self.owner_name or self.owner_uuid,
            message_id=message_id or None)
        return h.MessageEvent(
            text=text, message_type=h.MessageType.TEXT, source=source, message_id=message_id or None,
            raw_message=dict(wake.notification), allow_gateway_control=control,
            metadata={"chorus_chat_id": wake.chat_id, "chorus_wake": wake.label})

    async def _start(self, wake: WakeRequest) -> None:
        chat_id = wake.chat_id
        self._starting.add(chat_id)
        try:
            rec = TurnRecord(session_id=wake.session_id, entity=entity_of(wake.entity_type, wake.entity_uuid),
                             root_idea_uuid=wake.root_idea_uuid, direct_idea_uuid=wake.direct_idea_uuid,
                             requested_turn_uuid=wake.turn_uuid)
            turn = ActiveTurn(wake=wake, record=rec, chat_id=chat_id)
            self._active[chat_id] = turn
        finally:
            self._starting.discard(chat_id)
        admission = await self.turns.start(rec)
        if not admission.admitted:
            await self._not_admitted(turn, admission)
            return
        if self.router is not None:
            self.router.seen.add(f"turn:{admission.turn_uuid}")  # a later sweep must not re-run it
        if turn.interrupting or turn.shutdown:
            await self._finalize(turn, "interrupted", "shutdown" if turn.shutdown else "user")
            return
        if not wake.prompt_text:
            # The server already renders a human_instruction's promptText; for other wakes show
            # what woke the agent (without the per-wake headless preamble).
            shown = wake.prompt[len(HEADLESS_PREAMBLE):].lstrip("\n") if wake.prompt.startswith(
                HEADLESS_PREAMBLE) else wake.prompt
            await self.turns.transcript(rec, "user", shown)
        message_id = rec.turn_uuid or f"chorus-{uuidlib.uuid4().hex[:12]}"
        event = self._build_event(wake, wake.prompt, message_id=message_id)
        turn.event = event
        try:
            turn.session_key = self._source_session_key(event.source)
        except Exception:
            turn.session_key = None
        if turn.session_key:
            self.session_keys[turn.session_key] = self._mapping(turn)
        turn.dispatched = True
        try:
            await self.handle_message(event)
        except Exception as exc:
            logger.exception("[Chorus] handle_message failed for %s", wake.label)
            await self._finalize(turn, "interrupted", "crash",
                                 self.turns.wake_error(f"Hermes gateway rejected the wake: {exc}", kind="startup"))
            return
        if getattr(event, "_gateway_accepted", True) is False and self._active.get(chat_id) is turn:
            await self._finalize(turn, "interrupted", "crash",
                                 self.turns.wake_error("Hermes gateway did not accept the wake", kind="startup"))

    async def _not_admitted(self, turn: ActiveTurn, admission: Any) -> None:
        """The server did not admit the turn: no model run, no transcript, no terminal report.

        Nothing was marked running, so there is nothing of ours to end — and the session's turn may
        belong to another consumer (409), so it must not be touched. ``rejected`` drops the wake;
        ``unavailable`` releases its dedup keys so a reconnect sweep / ``deliver_turn`` retries it.
        """
        wake = turn.wake
        if self._active.get(turn.chat_id) is turn:
            self._active.pop(turn.chat_id, None)
        if admission.status == "unavailable" and self.router is not None:
            self.router.release(wake)
        logger.warning("[Chorus] wake %s not run: admission %s%s", wake.label, admission.status,
                       f" (HTTP {admission.http_status})" if admission.http_status else "")
        entity = turn.record.entity
        if entity and not any(entity_of(w.entity_type, w.entity_uuid) == entity
                              for q in self._queues.values() for w in q):
            await self.turns.drop_execution(entity)  # its queued row, if it waited behind another turn
        if self._queues.get(turn.chat_id):
            spawn(self._drain(turn.chat_id, None), self._bg)

    @staticmethod
    def _mapping(turn: ActiveTurn) -> Dict[str, Any]:
        entity = turn.record.entity or entity_for_chat_id(turn.chat_id)
        return {"chatId": turn.chat_id, "sessionId": turn.record.session_id,
                "entityType": entity[0] if entity else None, "entityUuid": entity[1] if entity else None,
                "directIdeaUuid": turn.record.direct_idea_uuid, "rootIdeaUuid": turn.record.root_idea_uuid,
                "projectUuid": turn.wake.notification.get("projectUuid")}

    def _turn_for_event(self, event: Any) -> Optional[ActiveTurn]:
        md = getattr(event, "metadata", None) or {}
        chat_id = md.get("chorus_chat_id") or getattr(getattr(event, "source", None), "chat_id", None)
        turn = self._active.get(chat_id) if chat_id else None
        if turn is None or not turn.dispatched:
            return None
        if turn.event is not None and getattr(event, "message_id", None) not in (None, turn.event.message_id):
            return None  # e.g. the /stop command event
        return turn

    async def on_processing_start(self, event: Any) -> None:
        turn = self._turn_for_event(event)
        if turn is not None:
            logger.info("[Chorus] turn running on %s (%s)", turn.chat_id, turn.wake.label)

    async def on_processing_complete(self, event: Any, outcome: Any) -> None:
        turn = self._turn_for_event(event)
        if turn is None:
            return
        po = self._h.ProcessingOutcome
        if turn.shutdown:
            await self._finalize(turn, "interrupted", "shutdown")
        elif turn.interrupting or outcome == po.CANCELLED:
            await self._finalize(turn, "interrupted", "user")
        elif outcome == po.FAILURE:
            message = turn.api_error or "Hermes turn failed (handler error or failed delivery)"
            await self._finalize(turn, "interrupted", "crash", self.turns.wake_error(message))
        elif turn.api_error:
            await self._finalize(turn, "interrupted", "crash",
                                 self.turns.wake_error(f"Provider error: {turn.api_error}"))
        else:
            await self._finalize(turn, "ended")

    async def _finalize(self, turn: ActiveTurn, status: str, reason: Optional[str] = None,
                        wake_error: Optional[Dict[str, Any]] = None) -> None:
        if self._active.get(turn.chat_id) is turn:
            self._active.pop(turn.chat_id, None)
        for sid in turn.hermes_session_ids:
            self._hermes_session_to_chat.pop(sid, None)
        await self.turns.finish(turn.record, status, reason, wake_error)
        if self._queues.get(turn.chat_id):
            spawn(self._drain(turn.chat_id, turn.session_key), self._bg)

    async def _drain(self, chat_id: str, session_key: Optional[str]) -> None:
        """Start the next queued wake once the gateway has released the session."""
        loop = asyncio.get_running_loop()
        deadline = loop.time() + DRAIN_WAIT_S
        active_sessions = getattr(self, "_active_sessions", {})
        while session_key and session_key in active_sessions and loop.time() < deadline:
            await asyncio.sleep(0.05)
        if chat_id in self._active or chat_id in self._starting:
            return
        queue = self._queues.get(chat_id)
        if not queue:
            return
        wake = queue.popleft()
        if not queue:
            self._queues.pop(chat_id, None)
        await self._start(wake)

    # -- interrupt ------------------------------------------------------------------------

    def _turn_for_entity(self, entity_type: str, entity_uuid: str) -> Optional[ActiveTurn]:
        for turn in self._active.values():
            if turn.record.entity == (entity_type, entity_uuid):
                return turn
            if entity_type == "idea" and turn.record.direct_idea_uuid == entity_uuid:
                return turn
        return None

    def is_entity_running(self, entity_type: str, entity_uuid: str) -> bool:
        return self._turn_for_entity(entity_type, entity_uuid) is not None

    async def interrupt_entity(self, entity_type: str, entity_uuid: str) -> bool:
        """Cancel the running Hermes turn for an entity (Chorus ``control`` interrupt)."""
        turn = self._turn_for_entity(entity_type, entity_uuid)
        if turn is None:
            return False
        turn.interrupting = True
        if not turn.dispatched:
            return True  # _start() finalizes it as interrupted/user before dispatching
        logger.info("[Chorus] interrupting turn on %s", turn.chat_id)
        try:
            stop = self._build_event(turn.wake, "/stop", control=True,
                                     message_id=f"chorus-stop-{uuidlib.uuid4().hex[:8]}")
            await self.handle_message(stop)
        except Exception:
            logger.debug("[Chorus] /stop dispatch failed", exc_info=True)
        spawn(self._ensure_stopped(turn), self._bg)
        return True

    async def _ensure_stopped(self, turn: ActiveTurn) -> None:
        loop = asyncio.get_running_loop()
        deadline = loop.time() + STOP_GRACE_S
        while self._active.get(turn.chat_id) is turn and loop.time() < deadline:
            await asyncio.sleep(0.1)
        if self._active.get(turn.chat_id) is not turn:
            return
        if turn.session_key and hasattr(self, "cancel_session_processing"):
            try:
                await self.cancel_session_processing(turn.session_key)
            except Exception:
                logger.debug("[Chorus] cancel_session_processing failed", exc_info=True)
        if self._active.get(turn.chat_id) is turn:
            await self._finalize(turn, "interrupted", "user")

    # -- outbound ---------------------------------------------------------------------------

    async def send(self, chat_id: str, content: str, reply_to: Optional[str] = None,
                   metadata: Optional[Dict[str, Any]] = None):
        """Record the agent's final reply as a transcript message. Never creates a Chorus comment."""
        md = metadata or {}
        turn = self._active.get(chat_id)
        if turn is not None and turn.dispatched and not turn.interrupting and not turn.shutdown \
                and md.get("notify") and not md.get("_interim_send"):
            await self.turns.transcript(turn.record, "assistant", content)
        return self._h.SendResult(success=True, message_id=f"chorus-{uuidlib.uuid4().hex[:12]}")

    async def get_chat_info(self, chat_id: str) -> Dict[str, Any]:
        return {"name": chat_id, "type": "dm"}

    # -- hook observers ------------------------------------------------------------------------

    def _turn_for_hermes_session(self, session_id: Any) -> Optional[ActiveTurn]:
        chat_id = self._hermes_session_to_chat.get(session_id) if isinstance(session_id, str) else None
        return self._active.get(chat_id) if chat_id else None

    def observe_llm_call(self, session_id: Any, user_message: Any) -> None:
        """Bind a Hermes ``session_id`` to the running Chorus turn whose prompt it is processing."""
        if not isinstance(session_id, str) or not session_id or session_id in self._hermes_session_to_chat:
            return
        unbound = [t for t in self._active.values() if t.dispatched and not t.hermes_session_ids]
        match = next((t for t in unbound if t.event is not None and t.event.text == user_message), None)
        if match is None and len(unbound) == 1:
            match = unbound[0]
        if match is not None:
            match.hermes_session_ids.add(session_id)
            self._hermes_session_to_chat[session_id] = match.chat_id
            if match.session_key and match.session_key in self.session_keys:
                self.session_keys[match.session_key]["hermesSessionId"] = session_id

    def observe_api_success(self, session_id: Any, usage: Any, model: Any) -> None:
        turn = self._turn_for_hermes_session(session_id)
        if turn is not None:
            turn.api_error = None
            turn.record.usage.add(usage, model)

    def observe_api_error(self, session_id: Any, error: Any, status_code: Any = None) -> None:
        turn = self._turn_for_hermes_session(session_id)
        if turn is None:
            return
        message = error.get("message") if isinstance(error, Mapping) else error
        text = str(message or "provider request failed")
        turn.api_error = f"{text} (HTTP {status_code})" if isinstance(status_code, int) else text

    def observe_loop_stopped(self, session_key: Any, reason: Any = None) -> None:
        if not isinstance(session_key, str):
            return
        for turn in self._active.values():
            if turn.session_key == session_key and not turn.shutdown:
                turn.interrupting = True


_ADAPTER_CLASS: Optional[type] = None


def adapter_class() -> type:
    """``ChorusPlatformAdapter`` = ``ChorusAdapterCore`` + Hermes ``BasePlatformAdapter`` (built once)."""
    global _ADAPTER_CLASS
    base = _hermes().BasePlatformAdapter
    if _ADAPTER_CLASS is None or base not in _ADAPTER_CLASS.__mro__:
        _ADAPTER_CLASS = type("ChorusPlatformAdapter", (ChorusAdapterCore, base), {
            "__doc__": "Hermes gateway platform adapter that holds a Chorus daemon connection.",
            "__module__": __name__,
        })
    return _ADAPTER_CLASS


def create_adapter(config: Any, **kwargs: Any):
    return adapter_class()(config, **kwargs)


def session_entity(session_key: Optional[str] = None, *, hermes_session_id: Optional[str] = None
                   ) -> Optional[Dict[str, Any]]:
    """Chorus entity for a Hermes ``session_key`` (or hook ``session_id``), across live adapters."""
    for adapter in list(_ADAPTERS):
        if session_key and session_key in adapter.session_keys:
            return dict(adapter.session_keys[session_key])
        if hermes_session_id:
            for mapping in adapter.session_keys.values():
                if mapping.get("hermesSessionId") == hermes_session_id:
                    return dict(mapping)
    return None


def live_adapters() -> List[ChorusAdapterCore]:
    return list(_ADAPTERS)


# -- hooks -------------------------------------------------------------------------------------


def _for_chorus(platform: Any) -> bool:
    return not platform or str(getattr(platform, "value", platform)).lower() == PLATFORM_NAME


def _hook_pre_llm_call(session_id=None, user_message=None, platform=None, **_: Any) -> None:
    if _for_chorus(platform):
        for adapter in live_adapters():
            adapter.observe_llm_call(session_id, user_message)
    return None


def _hook_post_api_request(session_id=None, usage=None, response_model=None, model=None, platform=None,
                           **_: Any) -> None:
    if _for_chorus(platform):
        for adapter in live_adapters():
            adapter.observe_api_success(session_id, usage, response_model or model)


def _hook_api_request_error(session_id=None, error=None, status_code=None, platform=None, **_: Any) -> None:
    if _for_chorus(platform):
        for adapter in live_adapters():
            adapter.observe_api_error(session_id, error, status_code)


def _hook_agent_loop_stopped(session_key=None, reason=None, **_: Any) -> None:
    for adapter in live_adapters():
        adapter.observe_loop_stopped(session_key, reason)


HOOKS = {
    "pre_llm_call": _hook_pre_llm_call,
    "post_api_request": _hook_post_api_request,
    "api_request_error": _hook_api_request_error,
    "agent_loop_stopped": _hook_agent_loop_stopped,
}


def check_requirements() -> bool:
    try:
        import httpx  # noqa: F401
    except Exception:
        return False
    return True


def is_connected(config: Any = None) -> bool:
    return chorus_config.is_configured()


def validate_config(config: Any = None) -> bool:
    return chorus_config.is_configured()


def register(ctx) -> None:
    """Register the ``chorus`` gateway platform and its observer hooks."""
    ctx.register_platform(
        name=PLATFORM_NAME, label=PLATFORM_LABEL, adapter_factory=lambda cfg: create_adapter(cfg),
        check_fn=check_requirements, validate_config=validate_config, is_connected=is_connected,
        required_env=[chorus_config.ENV_URL, chorus_config.ENV_API_KEY],
        install_hint="pip install httpx   # already a Hermes dependency",
        allowed_users_env=chorus_config.ENV_ALLOWED_USERS, emoji="🎼",
        allow_update_command=False, platform_hint=PLATFORM_HINT)
    for name, fn in HOOKS.items():
        try:
            ctx.register_hook(name, fn)
        except Exception:
            logger.exception("[Chorus] failed to register hook %s", name)
