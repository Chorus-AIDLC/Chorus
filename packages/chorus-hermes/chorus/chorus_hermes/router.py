"""Wake routing (port of ``cli/event-router.mjs`` + the control handler).

The router turns SSE events into :class:`WakeRequest` objects and hands each one
to ``dispatch``. Rules, in order, for a ``new_notification``:

1. dedup by ``notificationUuid`` (``inflight`` while being routed, ``seen`` once handled — the
   same two sets are keyed ``turn:<uuid>`` for pending turns);
2. re-read it via ``chorus_get_notifications {status:"unread", limit:50, autoMarkRead:false}``;
3. **pre-dispatch filters** see the re-read notification (any action) and may consume it
   — the hook point for the approval transport (``mentioned`` / ``comment_added`` replies);
4. skip when the action is not in ``WAKE_ACTIONS``;
5. skip ``human_instruction`` and operation actions (they arrive only as pending turns);
6. skip when ``suppressWake`` is true;
7. skip when ``targetConnectionUuid`` is set and is not this connection.

Dedup is two-phase: a key is ``inflight`` while its re-read / matching runs (so a concurrent
duplicate is dropped) and only moves to ``seen`` once the wake was dispatched or definitively
skipped. A retryable failure (notification re-read failed, original notification not found yet,
admission unavailable — see :meth:`EventRouter.release`) releases the key so a later sweep or
``deliver_turn`` recovers the turn.

Pending turns (``deliver_turn`` control pings and the reconnect sweep) go through the same
filters before dispatch (an autonomous pending turn reaches them even when its notification was
already handled live, so a filter can close it). ``control`` events are honoured only when ``targetConnectionUuid``
equals this connection.

Session mapping: every wake carries ``chat_id`` = ``idea:<directIdeaUuid>`` or
``<entityType>:<entityUuid>`` (see :func:`chat_id_for`), and ``session_id`` = the Chorus
business key (``directIdeaUuid`` or the entity uuid).
"""

from __future__ import annotations

import asyncio
import inspect
import logging
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Awaitable, Callable, Dict, List, Mapping, Optional, Union

from .prompts import OPERATION_ACTIONS, WAKE_ACTIONS, build_prompt

logger = logging.getLogger(__name__)

# Mirror of the server's NOTIFICATION_ACTION_TO_TURN_TRIGGER (cli/event-router.mjs).
ACTION_TO_TURN_TRIGGER = {
    "mentioned": "mentioned",
    "elaboration_verified": "elaboration_verified",
    "start_development": "start_development",
    "yolo_requested": "yolo_requested",
    "elaboration_requested": "elaboration",
    "elaboration_answered": "elaboration",
    "human_instruction": "human_instruction",
    "task_assigned": "task_assigned",
    "task_reopened": "task_assigned",
    "task_verified": "task_assigned",
    "idea_claimed": "task_assigned",
    "proposal_approved": "task_assigned",
    "proposal_rejected": "task_assigned",
}
AUTONOMOUS_TURN_TRIGGERS = frozenset(
    {"mentioned", "task_assigned", "elaboration_verified", "start_development", "yolo_requested"})
CONTROL_COMMANDS = frozenset({"interrupt", "resume", "deliver_turn"})

# Pending turn ↔ notification correlation by the turn's ``createdAt`` (see match_turn_notification).
TURN_MATCH_BEFORE_S = 1.0
TURN_MATCH_AFTER_S = 5.0
TURN_MATCH_MARGIN_S = 1.0
NOTIFICATION_PAGE_SIZE = 50
NOTIFICATION_MAX_PAGES = 5  # pending-turn replay pages back at most this many notification pages


def parse_time(value: Any) -> Optional[float]:
    """ISO-8601 (``…Z``) → epoch seconds, or ``None``."""
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


@dataclass
class WakeRequest:
    """One wake to run. ``source`` is ``notification`` | ``pending_turn`` | ``resume``."""
    source: str
    notification: Dict[str, Any]
    label: str
    entity_type: Optional[str] = None
    entity_uuid: Optional[str] = None
    direct_idea_uuid: Optional[str] = None
    root_idea_uuid: Optional[str] = None
    turn_uuid: Optional[str] = None  # set for a pending turn: sent on turn-advance running
    prompt: Optional[str] = None
    prompt_text: Optional[str] = None  # server-side promptText (human_instruction) — already in chat
    transport: Dict[str, Any] = field(default_factory=dict)
    pending_turn: Optional[Mapping[str, Any]] = None
    # A pending turn's own ``sessionId``: the server-side session the turn belongs to. When set it
    # IS the session (never re-derived from a notification or lineage).
    canonical_session_id: Optional[str] = None

    @property
    def action(self) -> Optional[str]:
        return self.notification.get("action")

    @property
    def session_id(self) -> Optional[str]:
        return self.canonical_session_id or self.direct_idea_uuid or self.entity_uuid

    @property
    def chat_id(self) -> str:
        return chat_id_for(self.direct_idea_uuid, self.entity_type, self.entity_uuid)


def chat_id_for(direct_idea_uuid: Optional[str], entity_type: Optional[str], entity_uuid: Optional[str]) -> str:
    """Gateway ``chat_id`` for a wake: one Hermes session per direct Idea."""
    if direct_idea_uuid:
        return f"idea:{direct_idea_uuid}"
    return f"{entity_type}:{entity_uuid}"


def entity_for_chat_id(chat_id: str) -> Optional[tuple]:
    """Inverse of :func:`chat_id_for`: ``(entityType, entityUuid)`` or ``None``."""
    if not isinstance(chat_id, str) or ":" not in chat_id:
        return None
    etype, _, euuid = chat_id.partition(":")
    return (etype, euuid) if etype and euuid else None


PreDispatchFilter = Callable[[WakeRequest], Union[bool, Awaitable[bool]]]


class LineageResolver:
    """``GET /api/entities/{type}/{uuid}/root-idea`` → ``(rootIdeaUuid, directIdeaUuid)``, cached."""

    def __init__(self, rest) -> None:
        self.rest = rest
        self.cache: Dict[str, tuple] = {}

    async def resolve(self, entity_type: Optional[str], entity_uuid: Optional[str]) -> tuple:
        if not entity_type or not entity_uuid or entity_type == "daemon_session":
            return (None, None)
        key = f"{entity_type}:{entity_uuid}"
        if key in self.cache:
            return self.cache[key]
        try:
            data = await self.rest.aget(f"/api/entities/{entity_type}/{entity_uuid}/root-idea")
        except Exception as exc:
            logger.warning("[Chorus] lineage lookup failed for %s: %s", key, type(exc).__name__)
            return (None, None)
        root = data.get("rootIdeaUuid") if isinstance(data, Mapping) else None
        direct = data.get("directIdeaUuid") if isinstance(data, Mapping) else None
        result = (root if isinstance(root, str) else None, direct if isinstance(direct, str) else None)
        self.cache[key] = result
        return result


class EventRouter:
    def __init__(
        self,
        *,
        mcp,
        lineage: LineageResolver,
        dispatch: Callable[[WakeRequest], Any],
        get_connection_uuid: Callable[[], Optional[str]],
        pending_turns: Optional[Callable[[], Awaitable[List[Mapping[str, Any]]]]] = None,
        wake_actions=WAKE_ACTIONS,
        seen: Optional[set] = None,
    ) -> None:
        self.mcp = mcp
        self.lineage = lineage
        self.dispatch = dispatch
        self.get_connection_uuid = get_connection_uuid
        self.pending_turns = pending_turns
        self.wake_actions = wake_actions
        self.seen: set = seen if seen is not None else set()  # handled (dispatched or definitively skipped)
        self.inflight: set = set()  # being routed right now (concurrent-duplicate guard)
        self.filters: List[PreDispatchFilter] = []
        self.control_hooks: Dict[str, Callable[..., Any]] = {}
        self.skipped: List[tuple] = []  # (label, reason) — diagnostics/tests

    # -- extension points ----------------------------------------------------------

    def add_pre_dispatch_filter(self, fn: PreDispatchFilter) -> None:
        """Register ``fn(wake) -> bool`` (sync or async). ``True`` consumes the wake: no turn starts.

        Notification wakes reach filters right after the re-read, BEFORE the skip rules, so a
        filter also sees ``comment_added`` and other non-wake actions; ``wake.transport`` carries
        ``targetConnectionUuid`` / ``suppressWake``. Pending turns reach filters before dispatch
        (``wake.pending_turn`` / ``wake.turn_uuid`` set).
        """
        self.filters.append(fn)

    async def _filtered(self, wake: WakeRequest) -> bool:
        for fn in list(self.filters):
            try:
                result = fn(wake)
                if inspect.isawaitable(result):
                    result = await result
            except Exception:
                logger.exception("[Chorus] pre-dispatch filter failed for %s", wake.label)
                continue
            if result is True:
                self._skip(wake.label, "consumed by pre-dispatch filter")
                return True
        return False

    # -- dedup ---------------------------------------------------------------------

    def _claim(self, key: str) -> bool:
        """Mark ``key`` in flight; False when it is already in flight or handled."""
        if key in self.seen or key in self.inflight:
            return False
        self.inflight.add(key)
        return True

    def _settle(self, key: str, handled: bool) -> None:
        """End ``key``'s flight; ``handled`` moves it to ``seen`` unless :meth:`release` already
        dropped it while the wake was being dispatched (admission unavailable)."""
        was_inflight = key in self.inflight
        self.inflight.discard(key)
        if handled and was_inflight:
            self.seen.add(key)

    def release(self, wake: "WakeRequest") -> None:
        """Forget a dispatched wake so it can be routed again (admission was unavailable).

        Drops its notification uuid and ``turn:<uuid>`` key from both dedup sets: a later
        reconnect sweep or ``deliver_turn`` re-dispatches the still-pending server turn.
        """
        keys = {wake.label}
        if wake.turn_uuid:
            keys.add(f"turn:{wake.turn_uuid}")
        nid = wake.notification.get("uuid") if isinstance(wake.notification, Mapping) else None
        if isinstance(nid, str) and nid:
            keys.add(nid)
        for key in keys:
            self.seen.discard(key)
            self.inflight.discard(key)
        logger.info("[Chorus] wake %s released for retry", wake.label)

    def _skip(self, label: str, reason: str) -> None:
        self.skipped.append((label, reason))
        logger.info("[Chorus] wake %s skipped: %s", label, reason)

    # -- notifications -------------------------------------------------------------

    async def _unread(self, status: str = "unread", offset: int = 0) -> Optional[List[Mapping[str, Any]]]:
        args: Dict[str, Any] = {"status": status, "limit": NOTIFICATION_PAGE_SIZE, "autoMarkRead": False}
        if offset:
            args["offset"] = offset
        try:
            result = await self.mcp.acall_tool("chorus_get_notifications", args)
        except Exception as exc:
            logger.warning("[Chorus] notification re-read failed: %s", type(exc).__name__)
            return None
        items = result.get("notifications") if isinstance(result, Mapping) else None
        return items if isinstance(items, list) else None

    async def handle_notification(self, event: Mapping[str, Any]) -> Optional[WakeRequest]:
        """Route one ``new_notification`` SSE event. Returns the dispatched wake (or ``None``)."""
        if not isinstance(event, Mapping) or event.get("type") != "new_notification":
            return None
        nid = event.get("notificationUuid")
        if not isinstance(nid, str) or not nid:
            logger.warning("[Chorus] new_notification missing notificationUuid, skipping")
            return None
        if not self._claim(nid):
            self._skip(nid, "duplicate notificationUuid")
            return None
        try:
            return await self._route_notification(event, nid)
        finally:
            self.inflight.discard(nid)  # never leave a key in flight (it was settled, or it failed)

    async def _route_notification(self, event: Mapping[str, Any], nid: str) -> Optional[WakeRequest]:
        transport = {
            "targetConnectionUuid": event.get("targetConnectionUuid")
            if isinstance(event.get("targetConnectionUuid"), str) else None,
            "suppressWake": event.get("suppressWake") is True,
        }
        notifications = await self._unread()
        if notifications is None:
            self._settle(nid, False)  # retryable: a later pending-turn sweep may still route it
            self._skip(nid, "could not fetch notifications")
            return None
        n = next((x for x in notifications if isinstance(x, Mapping) and x.get("uuid") == nid), None)
        if n is None:
            # Already read (e.g. by a check-in): not handled HERE, so its pending turn (if any) stays
            # replayable by the sweep instead of being skipped as an "already handled" copy.
            self._settle(nid, False)
            self._skip(nid, "not in unread list")
            return None
        # From here on the notification is handled (dispatched or definitively skipped).
        self._settle(nid, True)
        n = dict(n)
        wake = WakeRequest(source="notification", notification=n, label=nid,
                           entity_type=n.get("entityType"), entity_uuid=n.get("entityUuid"), transport=transport)
        if await self._filtered(wake):
            return None
        action = n.get("action")
        if action not in self.wake_actions:
            self._skip(nid, f"action {action!r} is not a wake action")
            return None
        if action == "human_instruction" or action in OPERATION_ACTIONS:
            self._skip(nid, f"{action} is delivered via pending turns only")
            return None
        if transport["suppressWake"]:
            self._skip(nid, "suppressWake (offline pin: notify-only)")
            return None
        target = transport["targetConnectionUuid"]
        if target and target != self.get_connection_uuid():
            self._skip(nid, f"directed to connection {target}")
            return None
        return await self._resolve_and_dispatch(wake)

    async def _resolve_and_dispatch(self, wake: WakeRequest) -> Optional[WakeRequest]:
        if wake.canonical_session_id is not None:
            # A pending turn's session is fixed by the server: only fill in the root for attribution.
            if wake.root_idea_uuid is None:
                root, _direct = await self.lineage.resolve(wake.entity_type, wake.entity_uuid)
                wake.root_idea_uuid = root or wake.direct_idea_uuid
        elif wake.direct_idea_uuid is None and wake.root_idea_uuid is None:
            root, direct = await self.lineage.resolve(wake.entity_type, wake.entity_uuid)
            wake.root_idea_uuid, wake.direct_idea_uuid = root, direct
        if wake.prompt is None:
            try:
                wake.prompt = build_prompt(wake.notification)
            except Exception as exc:
                self._skip(wake.label, f"prompt build failed: {exc}")
                return None
        if not wake.prompt:
            self._skip(wake.label, "no wake prompt for this action")
            return None
        if not wake.session_id:
            self._skip(wake.label, "no session anchor (entity / direct idea)")
            return None
        result = self.dispatch(wake)
        if inspect.isawaitable(result):
            await result
        return wake

    # -- pending turns -------------------------------------------------------------

    async def sweep_pending_turns(self, only_turn_uuid: Optional[str] = None) -> List[WakeRequest]:
        """Read this connection's pending turns and dispatch each unseen one."""
        if self.pending_turns is None:
            return []
        dispatched = []
        for turn in await self.pending_turns():
            if only_turn_uuid and turn.get("turnUuid") != only_turn_uuid:
                continue
            wake = await self.dispatch_pending_turn(turn)
            if wake is not None:
                dispatched.append(wake)
        return dispatched

    async def dispatch_pending_turn(self, turn: Mapping[str, Any]) -> Optional[WakeRequest]:
        turn_uuid, session_id = turn.get("turnUuid"), turn.get("sessionId")
        if not isinstance(turn_uuid, str) or not turn_uuid:
            logger.warning("[Chorus] pending-turn dispatch missing turnUuid, skipping")
            return None
        if not isinstance(session_id, str) or not session_id:
            logger.warning("[Chorus] pending-turn %s missing sessionId, skipping", turn_uuid)
            return None
        seen_key = f"turn:{turn_uuid}"
        if not self._claim(seen_key):
            return None
        try:
            wake, handled = await self._route_pending_turn(turn, turn_uuid, session_id, seen_key)
            self._settle(seen_key, handled)
            return wake
        finally:
            self.inflight.discard(seen_key)

    async def _route_pending_turn(self, turn, turn_uuid, session_id, seen_key) -> tuple:
        """``(dispatched wake or None, handled)``; ``handled=False`` leaves the turn recoverable."""
        trigger = turn.get("trigger")
        direct = turn.get("directIdeaUuid") if isinstance(turn.get("directIdeaUuid"), str) else None

        if trigger in AUTONOMOUS_TURN_TRIGGERS:
            return await self._redispatch_autonomous(turn, turn_uuid, session_id, direct, trigger)

        if trigger != "human_instruction":
            self._skip(seen_key, f"pending trigger {trigger!r} is not re-dispatched here")
            return None, False
        instruction = turn.get("promptText").strip() if isinstance(turn.get("promptText"), str) else ""
        if not instruction:
            self._skip(seen_key, "pending human_instruction has no promptText")
            return None, False
        n = {
            "action": "human_instruction",
            "entityType": "idea" if direct else "daemon_session",
            "entityUuid": direct or session_id,
            "instructionText": instruction,
        }
        wake = WakeRequest(source="pending_turn", notification=n, label=seen_key,
                           entity_type=n["entityType"], entity_uuid=n["entityUuid"],
                           direct_idea_uuid=direct, root_idea_uuid=direct, turn_uuid=turn_uuid,
                           prompt_text=turn.get("promptText"), pending_turn=turn,
                           canonical_session_id=session_id)
        if await self._filtered(wake):
            return None, True
        return await self._resolve_and_dispatch(wake), True

    async def _belongs(self, n: Mapping[str, Any], anchors: set, direct: Optional[str]) -> bool:
        """Whether notification ``n`` is about this session: its entity is an anchor, or (for an
        idea-anchored session) its entity's direct Idea is the session's (task-woken sessions)."""
        if n.get("entityUuid") in anchors:
            return True
        if not direct:
            return False
        _root, entity_direct = await self.lineage.resolve(n.get("entityType"), n.get("entityUuid"))
        return entity_direct == direct

    async def match_turn_notification(self, turn: Mapping[str, Any], candidates: List[Mapping[str, Any]],
                                      anchors: set, direct: Optional[str]) -> tuple:
        """``(notification, exact)`` for a pending turn. Only notifications of THIS turn's session
        (see :meth:`_belongs`) are ever returned — never a guess from another session or Idea.

        ``exact`` is True only when the turn's ``createdAt`` (the server creates the turn right after
        its notification) singles out one notification of this session: the nearest one in
        ``[-TURN_MATCH_BEFORE_S, +TURN_MATCH_AFTER_S]`` with a clear margin over the runner-up.
        Otherwise a best-effort match is returned with ``exact=False``: for a burst whose timing is
        ambiguous, the nearest in-window notification not yet claimed by another wake.
        """
        t = parse_time(turn.get("createdAt"))
        if t is not None:
            timed = []
            for x in candidates:
                nt = parse_time(x.get("createdAt"))
                if nt is not None and -TURN_MATCH_BEFORE_S <= t - nt <= TURN_MATCH_AFTER_S \
                        and await self._belongs(x, anchors, direct):
                    timed.append((abs(t - nt), x))
            timed.sort(key=lambda item: item[0])
            if len(timed) == 1 or (len(timed) > 1 and timed[1][0] - timed[0][0] > TURN_MATCH_MARGIN_S):
                return timed[0][1], True
            if timed:
                # Burst: timing can't single out one notification. Never drop the turn; hand it the
                # nearest notification not yet claimed by another wake, marked inexact so no filter
                # (e.g. the approval-reply filter) may close it.
                unclaimed = next((x for _, x in timed if x.get("uuid") not in self.seen), None)
                return (unclaimed or timed[0][1]), False
        match = next((x for x in candidates if x.get("entityUuid") in anchors), None)
        if match is None and direct:
            for x in candidates:
                if await self._belongs(x, anchors, direct):
                    match = x
                    break
        return match, False

    async def _find_turn_notification(self, turn, trigger, anchors, direct) -> tuple:
        """Page through notifications (read ones too) for the pending turn's own notification.

        ``(match, exact)``, or ``None`` when the re-read failed. Stops at the first page that yields
        a match, at a short page, or after ``NOTIFICATION_MAX_PAGES`` pages.
        """
        candidates: List[Mapping[str, Any]] = []
        match, exact = None, False
        for page in range(NOTIFICATION_MAX_PAGES):
            notifications = await self._unread(status="all", offset=page * NOTIFICATION_PAGE_SIZE)
            if notifications is None:
                return None
            candidates.extend(x for x in notifications if isinstance(x, Mapping) and isinstance(x.get("uuid"), str)
                              and ACTION_TO_TURN_TRIGGER.get(x.get("action")) == trigger)
            match, exact = await self.match_turn_notification(turn, candidates, anchors, direct)
            if match is not None or len(notifications) < NOTIFICATION_PAGE_SIZE:
                break
        return match, exact

    async def _redispatch_autonomous(self, turn, turn_uuid, session_id, direct, trigger) -> tuple:
        # Search read notifications too: the connect-time chorus_checkin marks up to 5 as read,
        # and the server-side pending turn (deduped by turnUuid) is what owes the wake.
        label = f"turn:{turn_uuid}"
        idea_prefix = session_id.split("::")[0] if direct is None and "::" in session_id else None
        anchors = {a for a in (direct, session_id, idea_prefix) if isinstance(a, str) and a}
        found = await self._find_turn_notification(turn, trigger, anchors, direct)
        if found is None:
            self._skip(label, "notification re-read failed (will retry)")
            return None, False
        match, exact = found
        if match is None:
            # Never borrow another session's notification; leave the turn pending for a later sweep.
            self._skip(label, f"no {trigger} notification of session {session_id} found (left pending)")
            return None, False
        n = dict(match)
        wake = WakeRequest(source="pending_turn", notification=n, label=label,
                           entity_type=n.get("entityType"), entity_uuid=n.get("entityUuid"),
                           direct_idea_uuid=direct, turn_uuid=turn_uuid, pending_turn=turn,
                           transport={"exactNotification": exact}, canonical_session_id=session_id)
        # Filters run before the broadcast-copy check: a pending turn whose live notification was
        # already consumed (e.g. an approval reply) must still be closed by the filter that owns it.
        if await self._filtered(wake):
            self.seen.add(match["uuid"])
            return None, True
        if match["uuid"] in self.inflight:
            # Its live copy is being routed right now; if that fails, a later sweep retries the turn.
            self._skip(label, f"live copy {match['uuid']} in flight")
            return None, False
        if match["uuid"] in self.seen:
            self._skip(label, f"broadcast copy {match['uuid']} already handled")
            return None, True
        self.seen.add(match["uuid"])
        return await self._resolve_and_dispatch(wake), True

    # -- resume ----------------------------------------------------------------------

    async def dispatch_resume(self, event: Mapping[str, Any]) -> Optional[WakeRequest]:
        etype, euuid = event.get("entityType"), event.get("entityUuid")
        if not isinstance(etype, str) or not isinstance(euuid, str) or not euuid:
            logger.warning("[Chorus] resume missing entityType/entityUuid, skipping")
            return None
        n: Dict[str, Any] = {"action": "resource_resumed", "entityType": etype, "entityUuid": euuid}
        if event.get("resumeReason") in ("user", "crash"):
            n["resumedFrom"] = event["resumeReason"]
        orch = event.get("orchestrator")
        if isinstance(orch, Mapping) and orch.get("type") == "agent" and isinstance(orch.get("uuid"), str) \
                and isinstance(orch.get("name"), str):
            n["orchestrator"] = dict(orch)
        wake = WakeRequest(source="resume", notification=n, label=f"resume:{etype}:{euuid}",
                           entity_type=etype, entity_uuid=euuid)
        return await self._resolve_and_dispatch(wake)

    # -- control -----------------------------------------------------------------------

    def control_targets_me(self, event: Mapping[str, Any]) -> bool:
        me = self.get_connection_uuid()
        return bool(me) and event.get("targetConnectionUuid") == me

    async def handle_control(self, event: Mapping[str, Any]) -> Optional[str]:
        """Handle a ``control`` event; returns the command acted on (or ``None``).

        ``control_hooks``: ``is_running(etype, euuid) -> bool``, ``interrupt(etype, euuid)``.
        """
        if not isinstance(event, Mapping) or event.get("type") != "control":
            return None
        command = event.get("command")
        if command not in CONTROL_COMMANDS:
            logger.warning("[Chorus] control command %r not supported; ignoring", command)
            return None
        if not self.control_targets_me(event):
            logger.info("[Chorus] control %s for connection %s ignored (this is %s)", command,
                        event.get("targetConnectionUuid"), self.get_connection_uuid())
            return None
        if command == "deliver_turn":
            turn_uuid = event.get("turnUuid") if isinstance(event.get("turnUuid"), str) else None
            await self.sweep_pending_turns(turn_uuid)
            return command
        etype, euuid = event.get("entityType"), event.get("entityUuid")
        if not isinstance(etype, str) or not isinstance(euuid, str):
            logger.warning("[Chorus] control %s missing entityType/entityUuid; ignoring", command)
            return None
        if command == "resume":
            await self.dispatch_resume(event)
            return command
        is_running = self.control_hooks.get("is_running", lambda t, u: False)
        if not is_running(etype, euuid):
            logger.info("[Chorus] control interrupt: nothing running for %s:%s", etype, euuid)
            return None
        interrupt = self.control_hooks.get("interrupt")
        if interrupt is not None:
            result = interrupt(etype, euuid)
            if inspect.isawaitable(result):
                await result
        return command


def spawn(coro, tasks: Optional[set] = None) -> "asyncio.Task":
    """Fire-and-forget a coroutine, keeping a strong ref in ``tasks`` until it finishes."""
    task = asyncio.ensure_future(coro)
    if tasks is not None:
        tasks.add(task)
        task.add_done_callback(tasks.discard)
    task.add_done_callback(_log_task_error)
    return task


def _log_task_error(task: "asyncio.Task") -> None:
    if task.cancelled():
        return
    exc = task.exception()
    if exc is not None:
        logger.error("[Chorus] background task failed: %s", exc, exc_info=exc)
