"""Minimal stateless JSON-RPC client for Chorus ``/api/mcp``.

Chorus MCP is stateless per request (a fresh server per POST), so hooks and the
gateway adapter can issue a bare ``tools/call`` without ``initialize``. The
server answers either ``application/json`` or a single-message
``text/event-stream``; both are handled. Uses ``httpx`` (a Hermes dependency).
"""

from __future__ import annotations

import itertools
import json
from typing import Any, Mapping, Optional

import httpx

from .config import ChorusConfig

DEFAULT_TIMEOUT = 20.0
_ids = itertools.count(1)


class McpError(RuntimeError):
    """Transport or JSON-RPC protocol failure."""


class McpToolError(McpError):
    """The tool ran and returned ``isError: true``."""

    def __init__(self, tool: str, text: str):
        super().__init__(f"Chorus MCP tool error ({tool}): {text}")
        self.tool = tool
        self.text = text


def _headers(cfg: ChorusConfig) -> dict:
    return {
        "Authorization": f"Bearer {cfg.api_key}",
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
    }


def build_request(name: str, arguments: Optional[Mapping[str, Any]] = None) -> dict:
    return {
        "jsonrpc": "2.0",
        "id": next(_ids),
        "method": "tools/call",
        "params": {"name": name, "arguments": dict(arguments or {})},
    }


def _parse_sse(body: str) -> list[dict]:
    messages, data_lines = [], []
    for line in body.splitlines() + [""]:
        if line.startswith("data:"):
            data_lines.append(line[5:].lstrip(" "))
        elif line == "" and data_lines:
            messages.append(json.loads("\n".join(data_lines)))
            data_lines = []
    return messages


def parse_response(response: httpx.Response, request_id: Any) -> dict:
    """Return the JSON-RPC ``result`` object for ``request_id`` or raise :class:`McpError`."""
    if response.status_code >= 400:
        raise McpError(f"Chorus MCP HTTP {response.status_code}")
    ctype = response.headers.get("content-type", "")
    try:
        if "text/event-stream" in ctype:
            messages = _parse_sse(response.text)
        else:
            payload = response.json()
            messages = payload if isinstance(payload, list) else [payload]
    except ValueError as exc:
        raise McpError(f"Chorus MCP returned an unparseable body: {exc}") from exc
    for msg in messages:
        if not isinstance(msg, dict) or ("id" in msg and msg["id"] != request_id):
            continue
        if "error" in msg:
            err = msg["error"] or {}
            raise McpError(f"Chorus MCP error {err.get('code')}: {err.get('message')}")
        if "result" in msg:
            return msg["result"]
    raise McpError("Chorus MCP response carried no result")


def result_text(result: Mapping[str, Any]) -> str:
    blocks = result.get("content") or []
    return "\n".join(b.get("text", "") for b in blocks if isinstance(b, dict) and b.get("type") == "text")


def decode_result(name: str, result: Mapping[str, Any]) -> Any:
    """JSON-decoded text content (raw text when not JSON); raise on ``isError``."""
    text = result_text(result)
    if result.get("isError"):
        raise McpToolError(name, text)
    try:
        return json.loads(text)
    except ValueError:
        return text


class ChorusMcpClient:
    """Sync + async ``tools/call`` against ``<CHORUS_URL>/api/mcp``."""

    def __init__(self, cfg: ChorusConfig, *, transport: Optional[httpx.BaseTransport] = None,
                 async_transport: Optional[httpx.AsyncBaseTransport] = None,
                 timeout: float = DEFAULT_TIMEOUT):
        self.cfg = cfg
        self._transport = transport
        self._async_transport = async_transport
        self._timeout = timeout

    def call_tool(self, name: str, arguments: Optional[Mapping[str, Any]] = None) -> Any:
        req = build_request(name, arguments)
        try:
            with httpx.Client(transport=self._transport, timeout=self._timeout) as client:
                response = client.post(self.cfg.mcp_url, json=req, headers=_headers(self.cfg))
        except httpx.HTTPError as exc:
            raise McpError(f"Chorus MCP request failed: {type(exc).__name__}") from exc
        return decode_result(name, parse_response(response, req["id"]))

    async def acall_tool(self, name: str, arguments: Optional[Mapping[str, Any]] = None) -> Any:
        req = build_request(name, arguments)
        try:
            async with httpx.AsyncClient(transport=self._async_transport, timeout=self._timeout) as client:
                response = await client.post(self.cfg.mcp_url, json=req, headers=_headers(self.cfg))
        except httpx.HTTPError as exc:
            raise McpError(f"Chorus MCP request failed: {type(exc).__name__}") from exc
        return decode_result(name, parse_response(response, req["id"]))
