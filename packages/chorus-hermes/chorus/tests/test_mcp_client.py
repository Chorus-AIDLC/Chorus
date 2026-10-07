import asyncio
import json

import httpx
import pytest

from chorus_hermes import mcp_client as m
from tests.conftest import FAKE_KEY


def _sse(payload):
    return httpx.Response(200, headers={"content-type": "text/event-stream"},
                          text=f"event: message\ndata: {json.dumps(payload)}\n\n")


def _result(req, text, is_error=False):
    body = json.loads(req.content)
    return {"jsonrpc": "2.0", "id": body["id"],
            "result": {"content": [{"type": "text", "text": text}], **({"isError": True} if is_error else {})}}


def test_call_tool_sse_stateless(cfg, mock_http):
    rec, sync, _ = mock_http(lambda r: _sse(_result(r, json.dumps({"agent": {"uuid": "a1"}}))))
    out = m.ChorusMcpClient(cfg, transport=sync).call_tool("chorus_checkin")
    assert out == {"agent": {"uuid": "a1"}}
    req = rec.requests[0]
    assert str(req.url) == "https://chorus.test/api/mcp"
    assert req.headers["authorization"] == f"Bearer {FAKE_KEY}"
    assert "text/event-stream" in req.headers["accept"]
    body = rec.last_json
    assert body["method"] == "tools/call"  # no initialize round-trip
    assert body["params"] == {"name": "chorus_checkin", "arguments": {}}
    assert len(rec.requests) == 1


def test_call_tool_json_response_and_args(cfg, mock_http):
    rec, sync, _ = mock_http(lambda r: httpx.Response(200, json=_result(r, "plain text")))
    assert m.ChorusMcpClient(cfg, transport=sync).call_tool("t", {"a": 1}) == "plain text"
    assert rec.last_json["params"]["arguments"] == {"a": 1}


def test_call_tool_batch_json_picks_matching_id(cfg, mock_http):
    def responder(r):
        good = _result(r, '"ok"')
        return httpx.Response(200, json=[{"jsonrpc": "2.0", "id": -1, "result": {}}, good])
    _, sync, _ = mock_http(responder)
    assert m.ChorusMcpClient(cfg, transport=sync).call_tool("t") == "ok"


def test_tool_error_raises(cfg, mock_http):
    _, sync, _ = mock_http(lambda r: _sse(_result(r, "Task not found", is_error=True)))
    with pytest.raises(m.McpToolError) as exc:
        m.ChorusMcpClient(cfg, transport=sync).call_tool("chorus_get_task", {"taskUuid": "x"})
    assert exc.value.text == "Task not found"
    assert exc.value.tool == "chorus_get_task"


def test_jsonrpc_error_raises(cfg, mock_http):
    def responder(r):
        return httpx.Response(200, json={"jsonrpc": "2.0", "id": json.loads(r.content)["id"],
                                         "error": {"code": -32602, "message": "bad params"}})
    _, sync, _ = mock_http(responder)
    with pytest.raises(m.McpError, match="-32602"):
        m.ChorusMcpClient(cfg, transport=sync).call_tool("t")


def test_http_error_does_not_leak_key(cfg, mock_http):
    _, sync, _ = mock_http(lambda r: httpx.Response(401, json={"error": "Unauthorized"}))
    with pytest.raises(m.McpError) as exc:
        m.ChorusMcpClient(cfg, transport=sync).call_tool("t")
    assert "401" in str(exc.value) and FAKE_KEY not in str(exc.value)


def test_unparseable_and_empty(cfg, mock_http):
    _, sync, _ = mock_http(lambda r: httpx.Response(200, headers={"content-type": "application/json"}, text="nope"))
    with pytest.raises(m.McpError, match="unparseable"):
        m.ChorusMcpClient(cfg, transport=sync).call_tool("t")
    _, sync, _ = mock_http(lambda r: _sse({"jsonrpc": "2.0", "method": "notifications/progress"}))
    with pytest.raises(m.McpError, match="no result"):
        m.ChorusMcpClient(cfg, transport=sync).call_tool("t")


def test_transport_failure_wrapped(cfg, mock_http):
    def boom(r):
        raise httpx.ConnectError("refused", request=r)
    _, sync, async_t = mock_http(boom)
    with pytest.raises(m.McpError, match="ConnectError"):
        m.ChorusMcpClient(cfg, transport=sync).call_tool("t")
    with pytest.raises(m.McpError, match="ConnectError"):
        asyncio.run(m.ChorusMcpClient(cfg, async_transport=async_t).acall_tool("t"))


def test_async_call_tool(cfg, mock_http):
    rec, _, async_t = mock_http(lambda r: _sse(_result(r, '{"n": 2}')))
    out = asyncio.run(m.ChorusMcpClient(cfg, async_transport=async_t).acall_tool("x", {"k": "v"}))
    assert out == {"n": 2}
    assert rec.last_json["params"] == {"name": "x", "arguments": {"k": "v"}}


def test_sse_multiline_data_and_ids_increase():
    a, b = m.build_request("a"), m.build_request("b")
    assert b["id"] > a["id"]
    msgs = m._parse_sse('data: {"a":\ndata: 1}\n\nevent: x\ndata: {"b": 2}')
    assert msgs == [{"a": 1}, {"b": 2}]


def test_result_text_joins_text_blocks():
    assert m.result_text({"content": [{"type": "text", "text": "a"}, {"type": "image"},
                                      {"type": "text", "text": "b"}]}) == "a\nb"
