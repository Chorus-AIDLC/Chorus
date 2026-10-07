"""Chorus notification SSE client (port of ``cli/sse-listener.mjs``).

``GET <CHORUS_URL>/api/events/notifications`` with the daemon self-report query
(``clientType=hermes``, ``clientVersion``, ``host``, ``cwd``, ``startedAt``,
``livenessAck=v1``). Data events are JSON on ``data: `` lines; comments start
with ``:``. Behaviour:

* ``connection_registered`` → store ``connectionUuid`` / ``connectedAt``, call
  ``on_registered`` (the adapter sweeps pending turns there).
* ``: heartbeat`` → ``POST /api/daemon/connection-heartbeat`` (bounded to 5s).
* ``control`` / ``connection_conflict`` are forked to their own callbacks and
  never reach ``on_event``; a conflict stops the client until restarted.
* No bytes for 75s, a closed stream or a failed request → reconnect after an
  exponential backoff (1s doubling to a 30s cap, reset on a successful connect).

Callbacks are synchronous and must not block; schedule async work yourself.
"""

from __future__ import annotations

import asyncio
import json
import logging
import socket
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, List, Mapping, Optional
from urllib.parse import urlencode

import httpx

from .config import ChorusConfig

logger = logging.getLogger(__name__)

CLIENT_TYPE = "hermes"
INITIAL_DELAY_S = 1.0
MAX_DELAY_S = 30.0
WATCHDOG_TIMEOUT_S = 75.0
HEARTBEAT_ACK_TIMEOUT_S = 5.0

EventCallback = Callable[[Mapping[str, Any]], None]


@dataclass(frozen=True)
class Registration:
    connection_uuid: str
    connected_at: Optional[str]


class SseParser:
    """Incremental SSE framing: feed decoded text, get raw message blocks back."""

    def __init__(self) -> None:
        self._buffer = ""

    def feed(self, text: str) -> List[str]:
        self._buffer += text.replace("\r", "")
        blocks = []
        while True:
            idx = self._buffer.find("\n\n")
            if idx < 0:
                return blocks
            blocks.append(self._buffer[:idx])
            self._buffer = self._buffer[idx + 2:]


def parse_block(raw: str) -> List[tuple]:
    """``[("comment", text) | ("data", obj) | ("bad", line)]`` for one SSE block."""
    out = []
    for line in raw.split("\n"):
        if line.startswith(":"):
            out.append(("comment", line[1:].strip()))
        elif line.startswith("data: "):
            try:
                out.append(("data", json.loads(line[6:])))
            except ValueError:
                out.append(("bad", line))
    return out


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class SseClient:
    def __init__(
        self,
        cfg: ChorusConfig,
        *,
        cwd: str,
        client_version: str,
        on_event: EventCallback,
        on_control: Optional[EventCallback] = None,
        on_conflict: Optional[EventCallback] = None,
        on_registered: Optional[Callable[[Registration, bool], None]] = None,
        ack_heartbeat: Optional[Callable[[Registration], Awaitable[Any]]] = None,
        host: Optional[str] = None,
        started_at: Optional[str] = None,
        transport: Optional[httpx.AsyncBaseTransport] = None,
        initial_delay: float = INITIAL_DELAY_S,
        max_delay: float = MAX_DELAY_S,
        watchdog_timeout: float = WATCHDOG_TIMEOUT_S,
        heartbeat_ack_timeout: float = HEARTBEAT_ACK_TIMEOUT_S,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        self.cfg = cfg
        self.on_event = on_event
        self.on_control = on_control or (lambda e: None)
        self.on_conflict = on_conflict or (lambda e: None)
        self.on_registered = on_registered or (lambda r, rc: None)
        self.ack_heartbeat = ack_heartbeat
        self.params = {
            "clientType": CLIENT_TYPE,
            "clientVersion": client_version,
            "host": host or socket.gethostname(),
            "cwd": cwd,
            "startedAt": started_at or _now_iso(),
            "livenessAck": "v1",
        }
        self.endpoint = f"{cfg.url}/api/events/notifications?{urlencode(self.params)}"
        self._transport = transport
        self.initial_delay = initial_delay
        self.max_delay = max_delay
        self.watchdog_timeout = watchdog_timeout
        self.heartbeat_ack_timeout = heartbeat_ack_timeout
        self._sleep = sleep
        self.reconnect_delay = initial_delay
        self.registration: Optional[Registration] = None
        self.connection_uuid: Optional[str] = None
        self.status = "disconnected"
        self.conflict: Optional[Mapping[str, Any]] = None
        self.connect_count = 0
        self.delays: List[float] = []  # observed backoff delays (diagnostics/tests)
        self._stopped = False
        self._tasks: set = set()

    # -- lifecycle -----------------------------------------------------------

    def stop(self) -> None:
        self._stopped = True
        self.status = "disconnected"
        self.registration = None

    @property
    def stopped(self) -> bool:
        return self._stopped

    async def run(self) -> None:
        """Connect and keep reconnecting until :meth:`stop` or a connection conflict."""
        while not self._stopped:
            try:
                await self._connect_once()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # never let the loop die
                logger.warning("[Chorus] SSE stream error: %s", type(exc).__name__)
            self.registration = None
            if self._stopped:
                break
            self.status = "reconnecting"
            delay = self.reconnect_delay
            self.delays.append(delay)
            logger.info("[Chorus] SSE reconnecting in %.0fs", delay)
            await self._sleep(delay)
            self.reconnect_delay = min(self.reconnect_delay * 2, self.max_delay)
        self.status = "disconnected"

    async def _connect_once(self) -> None:
        headers = {"Authorization": f"Bearer {self.cfg.api_key}", "Accept": "text/event-stream"}
        timeout = httpx.Timeout(connect=15.0, read=None, write=15.0, pool=15.0)
        async with httpx.AsyncClient(transport=self._transport, timeout=timeout) as client:
            try:
                async with client.stream("GET", self.endpoint, headers=headers) as response:
                    if response.status_code >= 400:
                        logger.error("[Chorus] SSE endpoint returned %s", response.status_code)
                        return
                    was_reconnect = self.connect_count > 0
                    self.connect_count += 1
                    self.status = "connected"
                    self.reconnect_delay = self.initial_delay
                    self._was_reconnect = was_reconnect
                    logger.info("[Chorus] SSE connection established")
                    await self._consume(response)
            except httpx.HTTPError as exc:
                logger.error("[Chorus] SSE connection failed: %s", type(exc).__name__)
                return
        if not self._stopped and self.conflict is None:
            logger.warning("[Chorus] SSE stream ended, scheduling reconnect")

    async def _consume(self, response: httpx.Response) -> None:
        parser = SseParser()
        chunks = response.aiter_text().__aiter__()
        while not self._stopped:
            try:
                chunk = await asyncio.wait_for(chunks.__anext__(), timeout=self.watchdog_timeout)
            except StopAsyncIteration:
                return
            except asyncio.TimeoutError:
                logger.warning("[Chorus] SSE stream received no bytes for %.0fs; reconnecting",
                               self.watchdog_timeout)
                return
            for block in parser.feed(chunk):
                self._process_block(block)
                if self._stopped:
                    return

    # -- message handling ------------------------------------------------------

    def _process_block(self, raw: str) -> None:
        for kind, value in parse_block(raw):
            if kind == "comment":
                if value == "heartbeat" and self.registration is not None:
                    self._spawn(self._ack(self.registration))
            elif kind == "bad":
                logger.warning("[Chorus] SSE JSON parse error")
            elif kind == "data":
                self._dispatch(value)

    def _dispatch(self, event: Any) -> None:
        if not isinstance(event, Mapping):
            return
        etype = event.get("type")
        if etype == "connection_registered" and isinstance(event.get("connectionUuid"), str):
            self.connection_uuid = event["connectionUuid"]
            connected_at = event.get("connectedAt") if isinstance(event.get("connectedAt"), str) else None
            self.registration = Registration(self.connection_uuid, connected_at)
            self._safe(self.on_registered, self.registration, getattr(self, "_was_reconnect", False))
            return
        if etype == "control":
            self._safe(self.on_control, event)
            return
        if etype == "connection_conflict":
            self.conflict = event
            logger.error(
                "[Chorus] connection conflict: another live client already serves host=%s cwd=%s for this "
                "agent; not retrying until the gateway restarts", event.get("host"), event.get("cwd"))
            self._safe(self.on_conflict, event)
            self.stop()
            return
        self._safe(self.on_event, event)

    async def _ack(self, registration: Registration) -> None:
        if self.ack_heartbeat is None or not registration.connected_at:
            return
        try:
            await asyncio.wait_for(self.ack_heartbeat(registration), timeout=self.heartbeat_ack_timeout)
        except Exception as exc:
            logger.warning("[Chorus] heartbeat acknowledgment failed: %s", type(exc).__name__)

    def _spawn(self, coro) -> None:
        task = asyncio.ensure_future(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    @staticmethod
    def _safe(fn: Callable, *args: Any) -> None:
        try:
            fn(*args)
        except Exception:
            logger.exception("[Chorus] SSE callback failed")

    async def drain(self) -> None:
        """Await in-flight heartbeat acks (tests / clean shutdown)."""
        while self._tasks:
            await asyncio.gather(*list(self._tasks), return_exceptions=True)
