"""Turn lifecycle reporting to ``/api/daemon/*`` (mirrors the CLI waker and the
OpenClaw daemon client).

Per turn, in order:

1. ``POST /api/daemon/turn-advance {status:"running"}`` → keep ``turn.uuid``
   (a pending turn sends its own ``turnUuid``).
2. ``POST /api/daemon/execution-state`` — the FULL running + queued snapshot,
   re-sent on every change.
3. ``POST /api/daemon/transcript`` — the user prompt and each final assistant reply.
4. A terminal ``turn-advance``: ``ended``, or ``interrupted`` with
   ``interruptedReason`` ``user`` | ``crash`` (+ strict ``wakeError``) | ``shutdown``.
5. ``POST /api/daemon/report-interrupt`` after a ``user`` / ``crash`` interrupt.

Every REST failure is logged and swallowed; nothing here raises into the gateway.
"""

from __future__ import annotations

import asyncio
import logging
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Mapping, Optional

from .rest import ChorusRest

logger = logging.getLogger(__name__)

WAKE_ERROR_SOURCE = "hermes"
WAKE_ERROR_KINDS = ("startup", "execution", "protocol")
EXECUTION_ENTITY_TYPES = frozenset({"task", "idea", "proposal", "document", "daemon_session"})
REPORT_INTERRUPT_REASONS = frozenset({"user", "crash"})
TERMINAL_REASONS = frozenset({"user", "crash", "shutdown"})

_CONTROL_CHARS = re.compile(r"[\u0000-\u0008\u000b-\u001f\u007f-\u009f]")
_ANSI = re.compile(r"\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]")
_BEARER = re.compile(r"\b(Bearer|Basic)\s+[^\s\"'`,;<>\\]+", re.IGNORECASE)
_CHO_KEY = re.compile(r"\bcho_[A-Za-z0-9_-]+")
_KV_SECRET = re.compile(
    r"(\b(?:authorization|(?:[\w-]*_)?(?:api[_-]?key|token|secret|password))[\"']?\s*[:=]\s*[\"']?)"
    r"([^\s\"'`,;<>\\]+)", re.IGNORECASE)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def sanitize(text: Any, secrets: tuple = ()) -> str:
    value = text if isinstance(text, str) else (str(text) if text is not None else "")
    value = _CONTROL_CHARS.sub("", _ANSI.sub("", value))
    for secret in sorted({s for s in secrets if s}, key=len, reverse=True):
        value = value.replace(secret, "[redacted]")
    value = _BEARER.sub(lambda m: f"{m.group(1)} [redacted]", value)
    value = _CHO_KEY.sub("[redacted]", value)
    value = _KV_SECRET.sub(lambda m: f"{m.group(1)}[redacted]", value)
    return value.strip()


def make_wake_error(message: Any, *, kind: str = "execution", details: Any = None,
                    secrets: tuple = ()) -> Dict[str, Any]:
    """The strict ``wakeError`` wire object (``src/lib/daemon-wake-error.ts``)."""
    if kind not in WAKE_ERROR_KINDS:
        kind = "execution"
    msg = re.sub(r"\s+", " ", sanitize(message, secrets))[:500].strip() or "Hermes agent wake failed"
    det = sanitize(details, secrets)[:8000] or None
    return {"kind": kind, "source": WAKE_ERROR_SOURCE, "message": msg, "details": det,
            "exitCode": None, "signal": None}


def entity_of(entity_type: Any, entity_uuid: Any) -> Optional[tuple]:
    if isinstance(entity_type, str) and entity_type in EXECUTION_ENTITY_TYPES \
            and isinstance(entity_uuid, str) and entity_uuid:
        return (entity_type, entity_uuid)
    return None


@dataclass
class Usage:
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_creation_tokens: int = 0
    model: Optional[str] = None
    seen: bool = False

    def add(self, summary: Optional[Mapping[str, Any]], model: Optional[str] = None) -> None:
        if not isinstance(summary, Mapping):
            return

        def num(key: str) -> int:
            v = summary.get(key)
            return int(v) if isinstance(v, (int, float)) and not isinstance(v, bool) and v >= 0 else 0

        self.input_tokens += num("input_tokens")
        self.output_tokens += num("output_tokens")
        self.cache_read_tokens += num("cache_read_tokens")
        self.cache_creation_tokens += num("cache_write_tokens")
        if isinstance(model, str) and model:
            self.model = model[:200]
        self.seen = True

    def wire(self) -> Optional[Dict[str, Any]]:
        if not self.seen:
            return None
        return {"inputTokens": self.input_tokens, "outputTokens": self.output_tokens,
                "cacheCreationTokens": self.cache_creation_tokens, "cacheReadTokens": self.cache_read_tokens,
                "model": self.model, "source": WAKE_ERROR_SOURCE}


@dataclass
class TurnRecord:
    """One reported turn. ``session_id`` is the Chorus business key (directIdea or entity)."""
    session_id: str
    entity: Optional[tuple]
    root_idea_uuid: Optional[str] = None
    direct_idea_uuid: Optional[str] = None
    requested_turn_uuid: Optional[str] = None
    turn_uuid: Optional[str] = None
    finished: bool = False
    usage: Usage = field(default_factory=Usage)


class TurnReporter:
    def __init__(self, rest: ChorusRest, get_connection_uuid: Callable[[], Optional[str]], *,
                 secrets: tuple = ()) -> None:
        self.rest = rest
        self.get_connection_uuid = get_connection_uuid
        self.secrets = secrets
        self.executions: Dict[str, Dict[str, Any]] = {}
        self.calls: List[tuple] = []  # (path, body) successfully attempted, for diagnostics
        self._lock = asyncio.Lock()

    # -- REST helpers ----------------------------------------------------------

    async def _post(self, path: str, body: Dict[str, Any]) -> Any:
        try:
            return await self.rest.apost(path, body)
        except Exception as exc:  # REST failures never crash the gateway
            logger.warning("[Chorus] POST %s failed: %s", path, sanitize(exc, self.secrets)[:300])
            return None

    def wake_error(self, message: Any, *, kind: str = "execution", details: Any = None) -> Dict[str, Any]:
        return make_wake_error(message, kind=kind, details=details, secrets=self.secrets)

    # -- execution snapshot ------------------------------------------------------

    @staticmethod
    def _key(entity: tuple) -> str:
        return f"{entity[0]}:{entity[1]}"

    def snapshot(self) -> List[Dict[str, Any]]:
        return [dict(row) for row in self.executions.values()]

    async def emit_snapshot(self) -> None:
        conn = self.get_connection_uuid()
        if not conn:
            return
        async with self._lock:
            await self._post("/api/daemon/execution-state",
                             {"connectionUuid": conn, "executions": self.snapshot()})

    async def mark_queued(self, entity: Optional[tuple], root: Optional[str], direct: Optional[str]) -> None:
        if not entity:
            return
        key = self._key(entity)
        existing = self.executions.get(key)
        if existing and existing["status"] == "running":
            return  # never downgrade a running resource
        self.executions[key] = {"entityType": entity[0], "entityUuid": entity[1], "rootIdeaUuid": root,
                                "directIdeaUuid": direct, "status": "queued",
                                "startedAt": existing.get("startedAt") if existing else None}
        await self.emit_snapshot()

    async def drop_execution(self, entity: Optional[tuple]) -> None:
        if entity and self.executions.pop(self._key(entity), None) is not None:
            await self.emit_snapshot()

    # -- turn lifecycle ----------------------------------------------------------

    async def _advance(self, rec: TurnRecord, status: str, *, turn_uuid: Optional[str] = None,
                       reason: Optional[str] = None, wake_error: Optional[Dict[str, Any]] = None,
                       usage: Optional[Dict[str, Any]] = None) -> Optional[str]:
        conn = self.get_connection_uuid()
        if not conn:
            logger.warning("[Chorus] turn-advance %s skipped: no registered connection", status)
            return None
        body: Dict[str, Any] = {"connectionUuid": conn, "sessionId": rec.session_id, "status": status}
        if turn_uuid:
            body["turnUuid"] = turn_uuid
        if rec.entity:
            body["entityType"], body["entityUuid"] = rec.entity
        if status == "interrupted":
            body["interruptedReason"] = reason
            if reason == "crash" and wake_error:
                body["wakeError"] = wake_error
        if usage:
            body["usage"] = usage
        data = await self._post("/api/daemon/turn-advance", body)
        turn = data.get("turn") if isinstance(data, Mapping) else None
        uuid = turn.get("uuid") if isinstance(turn, Mapping) else None
        return uuid if isinstance(uuid, str) else None

    async def start(self, rec: TurnRecord) -> Optional[str]:
        """turn-advance running, then mark the execution running + snapshot."""
        rec.turn_uuid = await self._advance(rec, "running", turn_uuid=rec.requested_turn_uuid)
        if rec.entity:
            self.executions[self._key(rec.entity)] = {
                "entityType": rec.entity[0], "entityUuid": rec.entity[1],
                "rootIdeaUuid": rec.root_idea_uuid, "directIdeaUuid": rec.direct_idea_uuid,
                "status": "running", "startedAt": _now_iso()}
            await self.emit_snapshot()
        return rec.turn_uuid

    async def transcript(self, rec: TurnRecord, role: str, text: str) -> None:
        if not isinstance(text, str) or not text.strip() or role not in ("user", "assistant"):
            return
        body: Dict[str, Any] = {"messages": [{"role": role, "text": text}]}
        if rec.turn_uuid:
            body["turnUuid"] = rec.turn_uuid
        else:
            body["sessionId"] = rec.session_id
        await self._post("/api/daemon/transcript", body)

    async def finish(self, rec: TurnRecord, status: str, reason: Optional[str] = None,
                     wake_error: Optional[Dict[str, Any]] = None) -> None:
        """Terminal turn-advance → report-interrupt (user/crash) → drop execution row."""
        if rec.finished:
            return
        rec.finished = True
        if status == "interrupted" and reason not in TERMINAL_REASONS:
            reason = "crash"
        if status == "interrupted" and reason == "crash" and not wake_error:
            wake_error = self.wake_error("Hermes agent turn failed")
        if rec.turn_uuid:
            await self._advance(rec, status, turn_uuid=rec.turn_uuid, reason=reason, wake_error=wake_error,
                                usage=rec.usage.wire())
        else:
            logger.warning("[Chorus] terminal report skipped — no admitted turn for session %s", rec.session_id)
        conn = self.get_connection_uuid()
        if status == "interrupted" and reason in REPORT_INTERRUPT_REASONS and rec.entity and conn:
            await self._post("/api/daemon/report-interrupt", {
                "connectionUuid": conn, "entityType": rec.entity[0], "entityUuid": rec.entity[1],
                "reason": reason})
        await self.drop_execution(rec.entity)

    async def close_unstarted(self, rec: TurnRecord) -> None:
        """Admit and immediately end a turn without running the agent (approval replies)."""
        rec.turn_uuid = await self._advance(rec, "running", turn_uuid=rec.requested_turn_uuid)
        if rec.turn_uuid:
            rec.finished = True
            await self._advance(rec, "ended", turn_uuid=rec.turn_uuid)
        await self.drop_execution(rec.entity)

    async def heartbeat(self, connection_uuid: str, connected_at: str) -> Any:
        return await self.rest.apost("/api/daemon/connection-heartbeat",
                                     {"connectionUuid": connection_uuid, "connectedAt": connected_at})

    async def pending_turns(self) -> List[Mapping[str, Any]]:
        conn = self.get_connection_uuid()
        if not conn:
            return []
        try:
            data = await self.rest.aget("/api/daemon/pending-turns", params={"connectionUuid": conn})
        except Exception as exc:
            logger.warning("[Chorus] pending-turns read failed: %s", sanitize(exc, self.secrets)[:300])
            return []
        turns = data.get("turns") if isinstance(data, Mapping) else None
        return [t for t in turns if isinstance(t, Mapping)] if isinstance(turns, list) else []
