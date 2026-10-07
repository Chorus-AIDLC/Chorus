import asyncio

import httpx
import pytest

from chorus_hermes import rest as r
from tests.conftest import FAKE_KEY


def test_get_unwraps_data(cfg, mock_http):
    rec, sync, _ = mock_http(lambda q: httpx.Response(200, json={"success": True, "data": {"turns": []}}))
    out = r.ChorusRest(cfg, transport=sync).get("/api/daemon/pending-turns", params={"limit": 5})
    assert out == {"turns": []}
    req = rec.requests[0]
    assert str(req.url) == "https://chorus.test/api/daemon/pending-turns?limit=5"
    assert req.headers["authorization"] == f"Bearer {FAKE_KEY}"


def test_post_sends_json(cfg, mock_http):
    rec, sync, _ = mock_http(lambda q: httpx.Response(200, json={"success": True, "data": {"ok": 1}}))
    assert r.ChorusRest(cfg, transport=sync).post("api/daemon/x", {"a": 1}) == {"ok": 1}
    assert rec.requests[0].method == "POST"
    assert rec.last_json == {"a": 1}


def test_success_false_raises(cfg, mock_http):
    _, sync, _ = mock_http(lambda q: httpx.Response(200, json={"success": False, "error": "nope"}))
    with pytest.raises(r.ChorusRestError, match="nope") as exc:
        r.ChorusRest(cfg, transport=sync).get("/api/x")
    assert exc.value.status == 200 and exc.value.path == "/api/x"


def test_http_error_uses_envelope_error(cfg, mock_http):
    _, sync, _ = mock_http(lambda q: httpx.Response(404, json={"success": False, "error": "Task not found"}))
    with pytest.raises(r.ChorusRestError) as exc:
        r.ChorusRest(cfg, transport=sync).get("/api/x")
    assert exc.value.status == 404 and exc.value.message == "Task not found"


def test_http_error_without_body(cfg, mock_http):
    _, sync, _ = mock_http(lambda q: httpx.Response(502, text="<html>bad gateway</html>"))
    with pytest.raises(r.ChorusRestError) as exc:
        r.ChorusRest(cfg, transport=sync).get("/api/x")
    assert exc.value.status == 502 and exc.value.message == "Bad Gateway"


def test_empty_2xx_is_none(cfg, mock_http):
    _, sync, _ = mock_http(lambda q: httpx.Response(204))
    assert r.ChorusRest(cfg, transport=sync).post("/api/x") is None


def test_non_envelope_raises(cfg, mock_http):
    _, sync, _ = mock_http(lambda q: httpx.Response(200, json=[1, 2]))
    with pytest.raises(r.ChorusRestError, match="envelope"):
        r.ChorusRest(cfg, transport=sync).get("/api/x")


def test_transport_error_wrapped(cfg, mock_http):
    def boom(q):
        raise httpx.ReadTimeout("slow", request=q)
    _, sync, async_t = mock_http(boom)
    with pytest.raises(r.ChorusRestError) as exc:
        r.ChorusRest(cfg, transport=sync).get("/api/x")
    assert exc.value.status == 0 and FAKE_KEY not in str(exc.value)
    with pytest.raises(r.ChorusRestError):
        asyncio.run(r.ChorusRest(cfg, async_transport=async_t).aget("/api/x"))


def test_async_get_and_post(cfg, mock_http):
    rec, _, async_t = mock_http(lambda q: httpx.Response(200, json={"success": True, "data": q.method}))
    client = r.ChorusRest(cfg, async_transport=async_t)
    assert asyncio.run(client.aget("/api/a")) == "GET"
    assert asyncio.run(client.apost("/api/b", {"x": 1})) == "POST"
    assert rec.last_json == {"x": 1}
