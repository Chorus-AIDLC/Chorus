"""sse.py: parsing, self-report query, heartbeat ack, watchdog, backoff, conflict."""

from __future__ import annotations

import asyncio
import time

from chorus_hermes.sse import Registration, SseClient, SseParser, parse_block

from .fixtures.chorus_fake import FakeChorus, wait_for

import httpx


def run(coro):
    return asyncio.run(coro)


def test_parser_handles_crlf_partial_frames_and_multiple_blocks():
    p = SseParser()
    assert p.feed(": connected\r\n\r\ndata: {\"a\"") == [": connected"]
    assert p.feed(": 1}\n\ndata: {\"b\": 2}\n\n") == ['data: {"a": 1}', 'data: {"b": 2}']


def test_parse_block_kinds():
    assert parse_block(": heartbeat") == [("comment", "heartbeat")]
    assert parse_block('data: {"type": "x"}') == [("data", {"type": "x"})]
    assert parse_block("data: {nope")[0][0] == "bad"
    assert parse_block("event: ignored") == []


def _client(cfg, fake, **kw):
    events = {"event": [], "control": [], "conflict": [], "registered": []}
    defaults = dict(
        cwd="/repo", client_version="1.2.3", host="box", started_at="2026-01-01T00:00:00.000Z",
        on_event=events["event"].append, on_control=events["control"].append,
        on_conflict=events["conflict"].append,
        on_registered=lambda reg, rc: events["registered"].append((reg, rc)),
        transport=httpx.MockTransport(fake))
    defaults.update(kw)
    return SseClient(cfg, **defaults), events


def test_subscribe_query_and_auth(cfg):
    fake = FakeChorus()

    async def go():
        client, _ = _client(cfg, fake)
        task = asyncio.ensure_future(client.run())
        await wait_for(lambda: fake.feeds)
        client.stop()
        fake.feed.close()
        await asyncio.wait_for(task, 2)

    run(go())
    method, path, query, _ = fake.calls[0]
    assert (method, path) == ("GET", "/api/events/notifications")
    assert query == {"clientType": "hermes", "clientVersion": "1.2.3", "host": "box", "cwd": "/repo",
                     "startedAt": "2026-01-01T00:00:00.000Z", "livenessAck": "v1"}


def test_event_forking_registration_and_heartbeat_ack(cfg):
    fake = FakeChorus()
    acks = []

    async def ack(reg: Registration):
        acks.append((reg, time.monotonic()))

    async def go():
        client, events = _client(cfg, fake, ack_heartbeat=ack)
        task = asyncio.ensure_future(client.run())
        await wait_for(lambda: fake.feeds)
        feed = fake.feed
        feed.push(": connected\n\n")
        feed.push(": heartbeat\n\n")  # before registration: not acknowledged
        feed.event({"type": "connection_registered", "connectionUuid": "c-1",
                    "connectedAt": "2026-01-01T00:00:01.000Z"})
        t0 = time.monotonic()
        feed.push(": heartbeat\n\n")
        feed.event({"type": "new_notification", "notificationUuid": "n-1"})
        feed.event({"type": "control", "command": "interrupt", "targetConnectionUuid": "c-1"})
        await wait_for(lambda: acks and events["control"] and events["event"])
        await client.drain()
        client.stop()
        feed.close()
        await asyncio.wait_for(task, 2)
        return client, events, t0

    client, events, t0 = run(go())
    assert client.connection_uuid == "c-1"
    assert [r for r, _ in events["registered"]] == [Registration("c-1", "2026-01-01T00:00:01.000Z")]
    assert events["registered"][0][1] is False  # first connect is not a reconnect
    assert [e["type"] for e in events["event"]] == ["new_notification"]  # control never reaches on_event
    assert [e["command"] for e in events["control"]] == ["interrupt"]
    assert len(acks) == 1 and acks[0][0].connection_uuid == "c-1"
    assert acks[0][1] - t0 < 5.0


def test_heartbeat_ack_posts_connection_heartbeat(cfg):
    """End-to-end ack through TurnReporter.heartbeat → POST /api/daemon/connection-heartbeat."""
    from chorus_hermes.rest import ChorusRest
    from chorus_hermes.turns import TurnReporter

    fake = FakeChorus()
    transport = httpx.MockTransport(fake)
    reporter = TurnReporter(ChorusRest(cfg, async_transport=transport), lambda: "c-1")

    async def go():
        client, _ = _client(cfg, fake, transport=transport,
                            ack_heartbeat=lambda reg: reporter.heartbeat(reg.connection_uuid, reg.connected_at))
        task = asyncio.ensure_future(client.run())
        await wait_for(lambda: fake.feeds)
        fake.feed.event({"type": "connection_registered", "connectionUuid": "c-1",
                         "connectedAt": "2026-01-01T00:00:01.000Z"})
        start = time.monotonic()
        fake.feed.push(": heartbeat\n\n")
        await wait_for(lambda: fake.bodies("/api/daemon/connection-heartbeat"), timeout=5.0)
        elapsed = time.monotonic() - start
        client.stop()
        fake.feed.close()
        await asyncio.wait_for(task, 2)
        return elapsed

    elapsed = run(go())
    assert elapsed < 5.0
    assert fake.bodies("/api/daemon/connection-heartbeat") == [
        {"connectionUuid": "c-1", "connectedAt": "2026-01-01T00:00:01.000Z"}]


def test_heartbeat_ack_is_bounded_to_timeout(cfg):
    fake = FakeChorus()

    async def slow(reg):
        await asyncio.sleep(10)

    async def go():
        client, _ = _client(cfg, fake, ack_heartbeat=slow, heartbeat_ack_timeout=0.05)
        task = asyncio.ensure_future(client.run())
        await wait_for(lambda: fake.feeds)
        fake.feed.event({"type": "connection_registered", "connectionUuid": "c-1", "connectedAt": "x"})
        fake.feed.push(": heartbeat\n\n")
        await asyncio.sleep(0.01)
        t0 = time.monotonic()
        await client.drain()
        client.stop()
        fake.feed.close()
        await asyncio.wait_for(task, 2)
        return time.monotonic() - t0

    assert run(go()) < 1.0


def test_watchdog_reconnects_after_silence_and_reports_reconnect(cfg):
    fake = FakeChorus()
    delays = []

    async def fake_sleep(d):
        delays.append(d)

    async def go():
        client, events = _client(cfg, fake, watchdog_timeout=0.05, sleep=fake_sleep)
        task = asyncio.ensure_future(client.run())
        await wait_for(lambda: fake.feeds)
        fake.feed.event({"type": "connection_registered", "connectionUuid": "c-1", "connectedAt": "x"})
        # ...then silence: the watchdog must drop the stream and reconnect
        await wait_for(lambda: len(fake.feeds) >= 2)
        fake.feed.event({"type": "connection_registered", "connectionUuid": "c-2", "connectedAt": "y"})
        await wait_for(lambda: len(events["registered"]) == 2)
        client.stop()
        fake.feed.close()
        await asyncio.wait_for(task, 2)
        return events

    events = run(go())
    assert delays[0] == 1.0
    assert [rc for _, rc in events["registered"]] == [False, True]


def test_bytes_refresh_the_watchdog(cfg):
    fake = FakeChorus()

    async def go():
        client, _ = _client(cfg, fake, watchdog_timeout=0.2, sleep=lambda d: asyncio.sleep(0))
        task = asyncio.ensure_future(client.run())
        await wait_for(lambda: fake.feeds)
        for _ in range(6):
            fake.feed.push(": heartbeat\n\n")
            await asyncio.sleep(0.08)
        connects = len(fake.feeds)
        client.stop()
        fake.feed.close()
        await asyncio.wait_for(task, 2)
        return connects

    assert run(go()) == 1


def test_backoff_doubles_to_cap_and_resets_after_success(cfg):
    fake = FakeChorus()
    fake.sse_status = [500] * 7 + [200] + [500] * 5
    delays = []
    client_ref = {}

    async def fake_sleep(d):
        delays.append(d)
        if len(delays) >= 10:
            client_ref["c"].stop()

    async def go():
        client, _ = _client(cfg, fake, sleep=fake_sleep)
        client_ref["c"] = client
        task = asyncio.ensure_future(client.run())
        await wait_for(lambda: fake.feeds)
        fake.feed.close()  # stream ends after a successful connect
        await asyncio.wait_for(task, 2)

    run(go())
    assert delays[:7] == [1.0, 2.0, 4.0, 8.0, 16.0, 30.0, 30.0]
    assert delays[7] == 1.0  # reset by the successful connect
    assert delays[8] == 2.0


def test_conflict_stops_without_reconnect(cfg):
    fake = FakeChorus()
    delays = []

    async def go():
        client, events = _client(cfg, fake, sleep=lambda d: delays.append(d) or asyncio.sleep(0))
        task = asyncio.ensure_future(client.run())
        await wait_for(lambda: fake.feeds)
        fake.feed.event({"type": "connection_conflict", "host": "box", "cwd": "/repo"})
        await asyncio.wait_for(task, 2)
        return client, events

    client, events = run(go())
    assert events["conflict"] == [{"type": "connection_conflict", "host": "box", "cwd": "/repo"}]
    assert client.stopped and delays == [] and len(fake.feeds) == 1
    assert events["event"] == []


def test_transport_error_schedules_reconnect(cfg):
    calls = []

    def boom(request):
        calls.append(request)
        raise httpx.ConnectError("down")

    delays = []
    holder = {}

    async def fake_sleep(d):
        delays.append(d)
        if len(delays) == 3:
            holder["c"].stop()

    async def go():
        client = SseClient(cfg, cwd="/r", client_version="1", on_event=lambda e: None,
                           transport=httpx.MockTransport(boom), sleep=fake_sleep)
        holder["c"] = client
        await asyncio.wait_for(client.run(), 2)

    run(go())
    assert delays == [1.0, 2.0, 4.0] and len(calls) == 3
