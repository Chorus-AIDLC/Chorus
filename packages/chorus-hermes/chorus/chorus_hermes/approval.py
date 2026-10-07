"""``chorus`` approval transport: unattended tool approvals routed through Chorus comments.

Activated by ``security.approval.transport: chorus`` (with ``transport_fallback: builtin`` so
interactive CLI/TUI sessions keep the built-in prompt). See the ``hermes-chorus-approval`` spec.

Flow:

1. Hermes fires ``pre_approval_request`` synchronously right before it invokes the transport,
   with ``session_key`` / ``request_id`` (README note 3). We record ``request_id → session_key``.
2. ``present(request)`` runs on a host worker thread. It maps the session key back to the Chorus
   entity the gateway adapter recorded for that wake. No mapping (not a Chorus-woken session) →
   it RAISES, which the host turns into the built-in prompt under ``transport_fallback: builtin``
   (otherwise deny). Returning ``None`` would be ``invalid`` → deny, so it never does that.
3. It posts a comment on the entity: @owner, the redacted command + description, the allowed
   replies and a 6-character token, then waits.
4. The decision comes from the next comment on that entity by the agent owner that carries the
   token: ``approve once|session|always <token>`` (only offered scopes) or ``deny <token>``.
   Anything else from the owner that carries the token is a deny; other authors are ignored.
   Replies arrive through the SSE router filter (live ``mentioned`` / ``comment_added``
   notifications and ``mentioned`` pending turns), with a periodic comment poll as a backstop.
5. Timeout → ``deny``.

Approval replies never become model turns: the router filter re-reads the triggering comment,
and if it matches the reply grammar it hands it here, skips the wake and closes the server-side
pending turn with ``turn-advance ended`` without running the agent.
"""

from __future__ import annotations

import asyncio
import logging
import re
import secrets
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Mapping, Optional, Tuple

from . import adapter as chorus_adapter
from .router import WakeRequest, parse_time
from .turns import TurnRecord, entity_of, sanitize

logger = logging.getLogger(__name__)

TRANSPORT_NAME = "chorus"
TOKEN_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # no 0/O/1/I look-alikes; still matches [A-Z0-9]
TOKEN_LENGTH = 6
COMMENTABLE = frozenset({"task", "idea", "proposal", "document"})
REPLY_ACTIONS = frozenset({"mentioned", "comment_added"})

# ``^(approve (once|session|always)|deny) [A-Z0-9]{6}\b`` (case-insensitive), after leading @mentions.
REPLY_RE = re.compile(r"^(?:approve\s+(once|session|always)|(deny))\s+([A-Z0-9]{6})\b", re.IGNORECASE)
_LEADING_MENTION = re.compile(r"^\s*(?:@\[[^\]]*\]\([^)]*\)|@[^\s,:]+)[\s,:]*")
_TOKEN_IN_TEXT = re.compile(r"(?<![A-Z0-9])([A-Z0-9]{6})(?![A-Z0-9])", re.IGNORECASE)

POLL_INTERVAL_S = 10.0       # comment re-read while waiting (backstop for a missed SSE event)
DEADLINE_MARGIN_S = 1.0      # answer before the host deadline so a deny is not discarded as late
REQUEST_MAP_TTL_S = 600.0    # stale pre_approval_request entries are pruned after this
COMMENT_PAGE_SIZE = 20
PENDING_TURN_RETRIES = 3     # the pending turn is created right after the notification; retry briefly
PENDING_TURN_RETRY_S = 0.5
MAX_COMMAND_CHARS = 2000


class NotAChorusSession(RuntimeError):
    """Raised by ``present`` for sessions not started by a Chorus wake (host applies its fallback)."""


# -- reply grammar ------------------------------------------------------------------------------


def strip_leading_mentions(text: str) -> str:
    previous = None
    while previous != text:
        previous = text
        text = _LEADING_MENTION.sub("", text, count=1)
    return text.strip()


def parse_reply(content: Any) -> Optional[Tuple[str, str]]:
    """``(choice, TOKEN)`` when ``content`` is an approval reply, else ``None``."""
    if not isinstance(content, str):
        return None
    match = REPLY_RE.match(strip_leading_mentions(content))
    if not match:
        return None
    choice = (match.group(1) or match.group(2)).lower()
    return choice, match.group(3).upper()


def is_approval_reply(content: Any) -> bool:
    return parse_reply(content) is not None


# -- pending requests ---------------------------------------------------------------------------


@dataclass
class PendingApproval:
    token: str
    request: Any
    target_type: str
    target_uuid: str
    owner_uuid: str
    chat_id: Optional[str]
    done: threading.Event = field(default_factory=threading.Event)
    choice: Optional[str] = None
    resolved_by: Optional[str] = None  # comment uuid
    seen_comments: set = field(default_factory=set)
    comment_uuid: Optional[str] = None  # our own approval comment


class ApprovalBroker:
    """Process-wide registry shared by the hook, the transport and the router filters."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._sessions: Dict[str, Tuple[Optional[str], Optional[str], float]] = {}
        self._pending: Dict[str, PendingApproval] = {}
        self.poll_interval = POLL_INTERVAL_S
        self.deadline_margin = DEADLINE_MARGIN_S

    # -- hook ---------------------------------------------------------------------------

    def on_pre_approval_request(self, request_id=None, session_key=None, session_id=None, surface=None,
                                **_: Any) -> None:
        """``pre_approval_request`` observer: remember which session asked for ``request_id``."""
        if not isinstance(request_id, str) or not request_id:
            return  # built-in surfaces (cli/gateway/smart) carry no request_id
        if isinstance(surface, str) and surface and surface != f"transport:{TRANSPORT_NAME}":
            return
        now = time.monotonic()
        with self._lock:
            for rid in [r for r, (_, _, t) in self._sessions.items() if now - t > REQUEST_MAP_TTL_S]:
                self._sessions.pop(rid, None)
            self._sessions[request_id] = (session_key if isinstance(session_key, str) else None,
                                          session_id if isinstance(session_id, str) else None, now)

    # -- lookups ------------------------------------------------------------------------

    def _session_for(self, request_id: str) -> Tuple[Optional[str], Optional[str]]:
        with self._lock:
            key, sid, _ = self._sessions.pop(request_id, (None, None, 0.0))
        return key, sid

    @staticmethod
    def _adapter_for(session_key: Optional[str], hermes_session_id: Optional[str]):
        for adapter in chorus_adapter.live_adapters():
            mappings = getattr(adapter, "session_keys", {}) or {}
            if session_key and session_key in mappings:
                return adapter, dict(mappings[session_key])
            if hermes_session_id:
                for mapping in mappings.values():
                    if mapping.get("hermesSessionId") == hermes_session_id:
                        return adapter, dict(mapping)
        return None, None

    def _new_token(self) -> str:
        while True:
            token = "".join(secrets.choice(TOKEN_ALPHABET) for _ in range(TOKEN_LENGTH))
            if token not in self._pending:
                return token

    def is_pending(self, token: str) -> bool:
        with self._lock:
            entry = self._pending.get(token)
            return entry is not None and not entry.done.is_set()

    def pending(self) -> List[PendingApproval]:
        with self._lock:
            return list(self._pending.values())

    # -- transport ----------------------------------------------------------------------

    def present(self, request: Any):
        """Host-invoked transport callback (runs on a host worker thread)."""
        session_key, hermes_session_id = self._session_for(request.request_id)
        adapter, mapping = self._adapter_for(session_key, hermes_session_id)
        if adapter is None or mapping is None:
            raise NotAChorusSession("approval request is not from a Chorus-woken gateway session")
        target_type, target_uuid = mapping.get("entityType"), mapping.get("entityUuid")
        if target_type not in COMMENTABLE or not isinstance(target_uuid, str):
            direct = mapping.get("directIdeaUuid")
            if isinstance(direct, str) and direct:
                target_type, target_uuid = "idea", direct
            else:
                raise NotAChorusSession(f"Chorus session has no commentable entity ({target_type})")
        owner = getattr(adapter, "owner_uuid", None)
        mcp = getattr(adapter, "mcp", None)
        if not isinstance(owner, str) or mcp is None:
            raise NotAChorusSession("Chorus adapter is not connected")

        with self._lock:
            token = self._new_token()
            entry = PendingApproval(token=token, request=request, target_type=target_type,
                                    target_uuid=target_uuid, owner_uuid=owner, chat_id=mapping.get("chatId"))
            self._pending[token] = entry
        try:
            body = render_comment(request, token, owner_uuid=owner, owner_name=getattr(adapter, "owner_name", None),
                                  secrets=_secrets_of(adapter))
            try:
                posted = mcp.call_tool("chorus_add_comment", {"targetType": target_type, "targetUuid": target_uuid,
                                                              "content": body})
            except Exception as exc:
                logger.warning("[Chorus] approval comment could not be posted (%s); denying",
                               type(exc).__name__)
                return request.respond("deny")
            if isinstance(posted, Mapping) and isinstance(posted.get("uuid"), str):
                entry.comment_uuid = posted["uuid"]
            logger.info("[Chorus] approval %s requested on %s:%s", token, target_type, target_uuid)
            self._wait(entry, adapter, request)
        finally:
            with self._lock:
                self._pending.pop(token, None)

        if entry.choice is None:
            logger.info("[Chorus] approval %s timed out; denying", token)
            self._post_quietly(mcp, entry, f"Approval `{token}` closed without a valid owner reply — denied.")
            return request.respond("deny")
        logger.info("[Chorus] approval %s resolved: %s", token, entry.choice)
        return request.respond(entry.choice)

    def _wait(self, entry: PendingApproval, adapter: Any, request: Any) -> None:
        timeout = float(getattr(request, "timeout_seconds", 300) or 0)
        margin = min(self.deadline_margin, timeout * 0.1)
        deadline = time.monotonic() + max(timeout - margin, 0.0)
        while not entry.done.is_set():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return
            if entry.done.wait(min(self.poll_interval, remaining)):
                return
            if entry.chat_id and not _chat_running(adapter, entry.chat_id):
                logger.info("[Chorus] approval %s abandoned: its turn is no longer running", entry.token)
                return
            try:
                result = adapter.mcp.call_tool("chorus_get_comments", {
                    "targetType": entry.target_type, "targetUuid": entry.target_uuid,
                    "page": 1, "pageSize": COMMENT_PAGE_SIZE})
            except Exception as exc:
                logger.debug("[Chorus] approval poll failed: %s", type(exc).__name__)
                continue
            for comment in reversed(_comments_of(result)):  # oldest first: "the next owner comment"
                self.offer(comment)

    @staticmethod
    def _post_quietly(mcp: Any, entry: PendingApproval, text: str) -> None:
        try:
            mcp.call_tool("chorus_add_comment", {"targetType": entry.target_type,
                                                 "targetUuid": entry.target_uuid, "content": text})
        except Exception:
            logger.debug("[Chorus] approval follow-up comment failed", exc_info=True)

    # -- replies ------------------------------------------------------------------------

    def offer(self, comment: Mapping[str, Any]) -> Optional[str]:
        """Feed one Chorus comment; returns the choice if it resolved a pending request."""
        if not isinstance(comment, Mapping):
            return None
        content = comment.get("content")
        if not isinstance(content, str):
            return None
        tokens = {m.upper() for m in _TOKEN_IN_TEXT.findall(content)}
        if not tokens:
            return None
        author = comment.get("author") if isinstance(comment.get("author"), Mapping) else {}
        author_uuid = author.get("uuid") or comment.get("authorUuid")
        author_type = author.get("type") or comment.get("authorType")
        target = (comment.get("targetType"), comment.get("targetUuid"))
        cid = comment.get("uuid")
        with self._lock:
            for token in tokens:
                entry = self._pending.get(token)
                if entry is None or entry.done.is_set():
                    continue
                if target != (entry.target_type, entry.target_uuid):
                    continue  # the reply belongs on the entity that asked
                if cid and (cid in entry.seen_comments or cid == entry.comment_uuid):
                    continue
                if cid:
                    entry.seen_comments.add(cid)
                if author_type not in (None, "user") or author_uuid != entry.owner_uuid:
                    logger.info("[Chorus] approval %s: ignoring reply from a non-owner", token)
                    continue
                parsed = parse_reply(content)
                allowed = tuple(getattr(entry.request, "allowed_choices", ("once", "deny")))
                if parsed and parsed[1] == token and parsed[0] in allowed:
                    entry.choice = parsed[0]
                else:
                    logger.info("[Chorus] approval %s: owner reply not a valid choice; denying", token)
                    entry.choice = "deny"
                entry.resolved_by = cid if isinstance(cid, str) else None
                entry.done.set()
                return entry.choice
        return None


def _chat_running(adapter: Any, chat_id: str) -> bool:
    """Whether an agent run is still live in ``chat_id`` (a Chorus turn or a Hermes-internal
    follow-up run such as an async delegation completion) — the approval is still wanted."""
    running = getattr(adapter, "chat_running", None)
    if callable(running):
        try:
            return bool(running(chat_id))
        except Exception:
            return True
    return chat_id in getattr(adapter, "_active", {chat_id: True})


def _secrets_of(adapter: Any) -> tuple:
    cfg = getattr(adapter, "chorus_cfg", None)
    key = getattr(cfg, "api_key", None)
    return (key,) if isinstance(key, str) and key else ()


def _comments_of(result: Any) -> List[Mapping[str, Any]]:
    items = result.get("comments") if isinstance(result, Mapping) else None
    return [c for c in items if isinstance(c, Mapping)] if isinstance(items, list) else []


def _fence(text: str) -> str:
    longest = max((len(m) for m in re.findall(r"`+", text)), default=0)
    ticks = "`" * max(3, longest + 1)
    return f"{ticks}\n{text}\n{ticks}"


def render_comment(request: Any, token: str, *, owner_uuid: str, owner_name: Optional[str] = None,
                   secrets: tuple = ()) -> str:
    """The approval comment body (command/description are host-redacted; sanitized again here)."""
    command = sanitize(getattr(request, "command", ""), secrets)
    if len(command) > MAX_COMMAND_CHARS:
        command = command[:MAX_COMMAND_CHARS] + "\n… (truncated)"
    description = re.sub(r"\s+", " ", sanitize(getattr(request, "description", ""), secrets)).strip()
    choices = tuple(getattr(request, "allowed_choices", ("once", "deny")))
    replies = [f"`approve {c} {token}`" for c in choices if c in ("once", "session", "always")]
    if "deny" in choices:
        replies.append(f"`deny {token}`")
    timeout = int(float(getattr(request, "timeout_seconds", 0) or 0))
    mention = f"@[{(owner_name or 'owner').replace(']', '')}](user:{owner_uuid})"
    lines = [
        f"{mention} **Approval needed** (token `{token}`)",
        "",
        f"Hermes wants to run a command that needs your approval: {description or 'dangerous command'}",
        "",
        _fence(command or "(no command text)"),
        "",
        "Reply on this entity with one of: " + " / ".join(replies),
        "",
        "`once` = this call only" + (", `session` = for the rest of this session" if "session" in choices else "")
        + (", `always` = remember permanently" if "always" in choices else "") + ".",
    ]
    if timeout > 0:
        lines.append(f"No matching reply within {timeout}s means **deny**.")
    return "\n".join(lines)


BROKER = ApprovalBroker()


# -- router filter: approval replies never start a turn -------------------------------------------
#
# Chorus links neither a Notification nor a pending turn to the comment behind it, so the filter
# re-derives the link and only acts when it is unambiguous:
#   comment ↔ notification: same author, created in [n - COMMENT_BEFORE_S, n + COMMENT_AFTER_S],
#     and — for ``mentioned`` — the server's context snippet in ``message`` equals the comment's
#     (``mention.service.ts`` buildContextSnippet); several candidates must agree or be separated
#     by a clear time margin;
#   pending turn ↔ notification: the router's ``createdAt`` match (``exactNotification``).
# Anything ambiguous fails open: the wake is dispatched normally and no turn is closed.

COMMENT_BEFORE_S = 30.0
COMMENT_AFTER_S = 1.0
COMMENT_MARGIN_S = 1.0
_MENTION_MARKUP = re.compile(r"@\[([^\]]+)\]\((?:user|agent):[0-9a-fA-F-]{36}(?:\?[^)]*)?\)")
_MENTION_MESSAGE = re.compile(r'mentioned you: "(.*)"\s*$', re.DOTALL)


def context_snippet(content: str) -> str:
    """Python port of ``buildContextSnippet`` (``src/services/mention.service.ts``)."""
    cleaned = _MENTION_MARKUP.sub(lambda m: f"@{m.group(1)}", content)
    return cleaned if len(cleaned) <= 120 else cleaned[:117] + "..."


def _snippet_matches(content: Any, snippet: str) -> bool:
    if not isinstance(content, str):
        return False
    mine = context_snippet(content)
    if mine == snippet:
        return True
    if snippet.endswith("...") and len(snippet) > 8:  # JS slices UTF-16 units; compare a safe prefix
        return context_snippet(content).startswith(snippet[:-5])
    return False


def _author_uuid(comment: Mapping[str, Any]) -> Any:
    author = comment.get("author") if isinstance(comment.get("author"), Mapping) else {}
    return author.get("uuid") or comment.get("authorUuid")


def triggering_comment(comments: List[Mapping[str, Any]], notification: Mapping[str, Any]
                       ) -> Optional[Mapping[str, Any]]:
    """The comment that produced ``notification``, or ``None`` when it cannot be singled out."""
    actor, when = notification.get("actorUuid"), parse_time(notification.get("createdAt"))
    if not isinstance(actor, str) or when is None:
        return None
    snippet = None
    if notification.get("action") == "mentioned":
        m = _MENTION_MESSAGE.search(notification.get("message") or "")
        snippet = m.group(1) if m else None
    cands = []
    for c in comments:
        t = parse_time(c.get("createdAt"))
        if _author_uuid(c) != actor or t is None or not (-COMMENT_BEFORE_S <= t - when <= COMMENT_AFTER_S):
            continue
        if snippet is not None and not _snippet_matches(c.get("content"), snippet):
            continue
        cands.append((abs(when - t), c))
    if not cands:
        return None
    cands.sort(key=lambda item: item[0])
    if len(cands) == 1 or len({c.get("content") for _, c in cands}) == 1:
        return cands[0][1]
    if cands[1][0] - cands[0][0] > COMMENT_MARGIN_S:
        return cands[0][1]
    return None


class ReplyFilter:
    """Pre-dispatch filter bound to one adapter + router."""

    def __init__(self, adapter: Any, router: Any, broker: ApprovalBroker = BROKER) -> None:
        self.adapter = adapter
        self.router = router
        self.broker = broker
        self.consumed: List[str] = []  # wake labels, diagnostics/tests

    def _applies(self, wake: WakeRequest) -> bool:
        n = wake.notification if isinstance(wake.notification, Mapping) else {}
        if wake.source == "notification":
            return n.get("action") in REPLY_ACTIONS
        if wake.source == "pending_turn":
            trigger = wake.pending_turn.get("trigger") if isinstance(wake.pending_turn, Mapping) else None
            if trigger != "mentioned":
                return False
            if not wake.transport.get("exactNotification"):
                logger.info("[Chorus] %s: cannot tie the pending turn to one notification; dispatching "
                            "normally", wake.label)
                return False
            return True
        return False

    async def __call__(self, wake: WakeRequest) -> bool:
        if not self._applies(wake):
            return False
        n = wake.notification
        etype, euuid = n.get("entityType"), n.get("entityUuid")
        if etype not in COMMENTABLE or not isinstance(euuid, str) or self.adapter.mcp is None:
            return False
        try:
            result = await self.adapter.mcp.acall_tool("chorus_get_comments", {
                "targetType": etype, "targetUuid": euuid, "page": 1, "pageSize": COMMENT_PAGE_SIZE})
        except Exception as exc:
            logger.warning("[Chorus] comment re-read for %s failed: %s", wake.label, type(exc).__name__)
            return False
        comment = triggering_comment(_comments_of(result), n)
        if comment is None:
            if n.get("action") == "mentioned":
                logger.info("[Chorus] %s: triggering comment not identified; dispatching normally", wake.label)
            return False
        parsed = parse_reply(comment.get("content"))
        if parsed is None:
            return False
        resolved = self.broker.offer(comment)
        if resolved is None and not self.broker.is_pending(parsed[1]):
            logger.info("[Chorus] %s: approval-style comment %s by %s matches no pending request; "
                        "consumed without a turn", wake.label, comment.get("uuid"), _author_uuid(comment))
        self.consumed.append(wake.label)
        logger.info("[Chorus] %s is an approval reply; not starting a turn", wake.label)
        if wake.source == "pending_turn" and wake.turn_uuid:
            await self._close(wake.turn_uuid, wake.pending_turn.get("sessionId"), etype, euuid)
        elif n.get("action") == "mentioned":
            chorus_adapter.spawn(self._close_live_mention(n), getattr(self.adapter, "_bg", None))
        return True

    async def _close(self, turn_uuid: str, session_id: Any, etype: str, euuid: str) -> None:
        turns = self.adapter.turns
        if turns is None or not isinstance(session_id, str) or not session_id:
            return
        self.router.seen.add(f"turn:{turn_uuid}")
        entity = entity_of(etype, euuid)
        if entity and turns._key(entity) in turns.executions:
            entity = None  # never drop the execution row of the turn that is waiting for approval
        await turns.close_unstarted(TurnRecord(session_id=session_id, entity=entity,
                                               requested_turn_uuid=turn_uuid))

    async def _close_live_mention(self, n: Mapping[str, Any]) -> None:
        """A live @mention reply also left a server-side ``mentioned`` pending turn: close exactly it.

        The turn is the one the router's ``createdAt`` correlation ties to this notification; with
        no unambiguous match (or a server without ``createdAt``) it is left alone.
        """
        turns = self.adapter.turns
        if turns is None:
            return
        for attempt in range(PENDING_TURN_RETRIES):
            pending = [t for t in await turns.pending_turns() if t.get("trigger") == "mentioned"
                       and f"turn:{t.get('turnUuid')}" not in self.router.seen]
            turn = await self._turn_for_notification(pending, n)
            if turn is not None:
                await self._close(turn["turnUuid"], turn.get("sessionId"), n.get("entityType"), n.get("entityUuid"))
                return
            if attempt + 1 < PENDING_TURN_RETRIES:
                await asyncio.sleep(PENDING_TURN_RETRY_S)
        logger.info("[Chorus] approval reply %s: no pending turn tied to it; leaving pending turns alone",
                    n.get("uuid"))

    async def _turn_for_notification(self, pending: List[Mapping[str, Any]], n: Mapping[str, Any]
                                     ) -> Optional[Mapping[str, Any]]:
        """The pending turn whose router correlation picks exactly ``n`` (the inverse match)."""
        if not pending:
            return None
        notifications = await self.router._unread(status="all") or []
        candidates = [x for x in notifications if isinstance(x, Mapping) and x.get("action") == "mentioned"
                      and isinstance(x.get("uuid"), str)]
        if not any(x.get("uuid") == n.get("uuid") for x in candidates):
            candidates.append(n)
        found = []
        for turn in pending:
            session_id = turn.get("sessionId")
            if not isinstance(session_id, str) or not session_id:
                continue
            direct = turn.get("directIdeaUuid") if isinstance(turn.get("directIdeaUuid"), str) else None
            prefix = session_id.split("::")[0] if direct is None and "::" in session_id else None
            anchors = {a for a in (direct, session_id, prefix) if a}
            match, exact = await self.router.match_turn_notification(turn, candidates, anchors, direct)
            if exact and match is not None and match.get("uuid") == n.get("uuid"):
                found.append(turn)
        return found[0] if len(found) == 1 else None


def _setup_router(adapter: Any, router: Any) -> None:
    router.add_pre_dispatch_filter(ReplyFilter(adapter, router))


# -- registration ------------------------------------------------------------------------------------


HOOKS = {"pre_approval_request": BROKER.on_pre_approval_request}


def present(request: Any):
    return BROKER.present(request)


def register(ctx) -> None:
    """Register the ``chorus`` approval transport, its correlation hook and the router filter."""
    chorus_adapter.on_router_created(_setup_router)
    register_transport = getattr(ctx, "register_approval_transport", None)
    if register_transport is None:
        logger.warning("[Chorus] this Hermes has no approval transports; Chorus approvals disabled")
        return
    register_transport(TRANSPORT_NAME, present)
    for name, fn in HOOKS.items():
        ctx.register_hook(name, fn)
