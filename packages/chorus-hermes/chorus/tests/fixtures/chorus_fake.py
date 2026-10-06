"""A fake Chorus server for ``httpx.MockTransport``: daemon REST, MCP, SSE."""

from __future__ import annotations

import asyncio
import json
from typing import Any, Callable, Dict, List, Optional
from urllib.parse import parse_qs, urlsplit

import httpx


class SseFeed(httpx.AsyncByteStream):
    """A controllable SSE body: ``push(text)`` frames, ``close()`` ends the stream."""

    def __init__(self) -> None:
        self.queue: asyncio.Queue = asyncio.Queue()
        self.closed = False

    def push(self, text: str) -> None:
        self.queue.put_nowait(text.encode("utf-8"))

    def event(self, obj: Dict[str, Any]) -> None:
        self.push(f"data: {json.dumps(obj)}\n\n")

    def close(self) -> None:
        self.queue.put_nowait(None)

    async def __aiter__(self):
        while True:
            chunk = await self.queue.get()
            if chunk is None:
                self.closed = True
                return
            yield chunk

    async def aclose(self) -> None:
        self.closed = True


def envelope(data: Any, status: int = 200) -> httpx.Response:
    return httpx.Response(status, json={"success": True, "data": data})


def error(status: int, message: str = "boom") -> httpx.Response:
    return httpx.Response(status, json={"success": False, "error": message})


def mcp_result(payload: Any) -> Dict[str, Any]:
    return {"content": [{"type": "text", "text": json.dumps(payload)}]}


class FakeChorus:
    """Routes requests by path; records ``(method, path, query, body)``."""

    def __init__(self) -> None:
        self.calls: List[tuple] = []
        self.feeds: List[SseFeed] = []
        self.sse_status: List[int] = []  # statuses to answer successive SSE connects with
        self.notifications: List[Dict[str, Any]] = []
        self.pending: List[Dict[str, Any]] = []
        self.lineage: Dict[str, tuple] = {}
        self.owner = {"uuid": "owner-1", "name": "Felix", "email": None}
        self.turn_counter = 0
        self.fail_paths: set = set()
        self.tools: Dict[str, Callable[[Dict[str, Any]], Any]] = {
            "chorus_checkin": lambda args: {"agent": {"uuid": "agent-1", "name": "Hermes", "owner": self.owner}},
            "chorus_get_notifications": lambda args: {"notifications": list(self.notifications)},
        }
        self.feed_ready = asyncio.Event()

    # -- helpers ---------------------------------------------------------------

    def bodies(self, path: str) -> List[Any]:
        return [c[3] for c in self.calls if c[1] == path]

    def paths(self) -> List[str]:
        return [c[1] for c in self.calls if c[1] != "/api/mcp"]

    def tool_calls(self, name: str) -> List[Dict[str, Any]]:
        return [c[3]["params"]["arguments"] for c in self.calls
                if c[1] == "/api/mcp" and c[3]["params"]["name"] == name]

    @property
    def feed(self) -> SseFeed:
        return self.feeds[-1]

    # -- handler -----------------------------------------------------------------

    def __call__(self, request: httpx.Request) -> httpx.Response:
        url = urlsplit(str(request.url))
        path, query = url.path, {k: v[0] for k, v in parse_qs(url.query).items()}
        body = json.loads(request.content) if request.content else None
        self.calls.append((request.method, path, query, body))
        if path in self.fail_paths:
            return error(500)
        if path == "/api/events/notifications":
            status = self.sse_status.pop(0) if self.sse_status else 200
            if status != 200:
                return httpx.Response(status, text="no")
            feed = SseFeed()
            self.feeds.append(feed)
            self.feed_ready.set()
            return httpx.Response(200, headers={"content-type": "text/event-stream"}, stream=feed)
        if path == "/api/mcp":
            name = body["params"]["name"]
            fn = self.tools.get(name)
            result = mcp_result(fn(body["params"]["arguments"])) if fn else {
                "content": [{"type": "text", "text": "unknown tool"}], "isError": True}
            return httpx.Response(200, json={"jsonrpc": "2.0", "id": body["id"], "result": result})
        if path == "/api/daemon/turn-advance":
            if body.get("turnUuid"):
                uuid = body["turnUuid"]
            else:
                self.turn_counter += 1
                uuid = f"turn-{self.turn_counter}"
            return envelope({"turn": {"uuid": uuid, "status": body["status"]}})
        if path == "/api/daemon/pending-turns":
            return envelope({"turns": list(self.pending)})
        if path.startswith("/api/entities/"):
            parts = path.split("/")
            root, direct = self.lineage.get(f"{parts[3]}:{parts[4]}", (None, None))
            return envelope({"rootIdeaUuid": root, "directIdeaUuid": direct})
        return envelope({"ok": True})


async def wait_for(predicate: Callable[[], bool], timeout: float = 2.0) -> None:
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while not predicate():
        if loop.time() > deadline:
            raise AssertionError("condition not met in time")
        await asyncio.sleep(0.005)
