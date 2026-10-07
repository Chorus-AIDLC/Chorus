"""turns.py: reporting order, payload shapes, wakeError strictness, failure tolerance."""

from __future__ import annotations

import asyncio

import httpx

from chorus_hermes.rest import ChorusRest
from chorus_hermes.turns import TurnRecord, TurnReporter, make_wake_error

from .fixtures.chorus_fake import FakeChorus


def run(coro):
    return asyncio.run(coro)


def reporter(cfg, fake, conn="c-1"):
    return TurnReporter(ChorusRest(cfg, async_transport=httpx.MockTransport(fake)), lambda: conn,
                        secrets=("cho_" + "supersecretvalue1234",))


def rec(**kw):
    base = dict(session_id="i-1", entity=("task", "t-1"), root_idea_uuid="r-1", direct_idea_uuid="i-1")
    base.update(kw)
    return TurnRecord(**base)


def test_ended_turn_order_and_payloads(cfg):
    fake = FakeChorus()
    r = reporter(cfg, fake)
    t = rec()

    async def go():
        await r.mark_queued(("task", "t-1"), "r-1", "i-1")
        await r.start(t)
        await r.transcript(t, "user", "wake text")
        await r.transcript(t, "assistant", "done")
        await r.finish(t, "ended")

    run(go())
    assert fake.paths() == ["/api/daemon/execution-state", "/api/daemon/turn-advance", "/api/daemon/execution-state",
                            "/api/daemon/transcript", "/api/daemon/transcript", "/api/daemon/turn-advance",
                            "/api/daemon/execution-state"]
    states = fake.bodies("/api/daemon/execution-state")
    assert states[0]["executions"][0]["status"] == "queued"
    assert states[1]["connectionUuid"] == "c-1"
    assert states[1]["executions"][0] | {"startedAt": None} == {
        "entityType": "task", "entityUuid": "t-1", "rootIdeaUuid": "r-1", "directIdeaUuid": "i-1",
        "status": "running", "startedAt": None}
    assert states[2]["executions"] == []
    running, ended = fake.bodies("/api/daemon/turn-advance")
    assert running == {"connectionUuid": "c-1", "sessionId": "i-1", "status": "running", "entityType": "task",
                       "entityUuid": "t-1"}
    assert t.turn_uuid == "turn-1"
    assert ended == {"connectionUuid": "c-1", "sessionId": "i-1", "status": "ended", "turnUuid": "turn-1",
                     "entityType": "task", "entityUuid": "t-1"}
    assert fake.bodies("/api/daemon/transcript")[0] == {"messages": [{"role": "user", "text": "wake text"}],
                                                       "turnUuid": "turn-1"}
    assert "/api/daemon/report-interrupt" not in fake.paths()


def test_snapshot_includes_queued_rows_alongside_running(cfg):
    fake = FakeChorus()
    r = reporter(cfg, fake)

    async def go():
        await r.start(rec())
        await r.mark_queued(("task", "t-2"), "r-1", "i-1")
        await r.mark_queued(("task", "t-1"), "r-1", "i-1")  # never downgrades running

    run(go())
    last = fake.bodies("/api/daemon/execution-state")[-1]["executions"]
    assert {(e["entityUuid"], e["status"]) for e in last} == {("t-1", "running"), ("t-2", "queued")}


def test_pending_turn_sends_its_turn_uuid(cfg):
    fake = FakeChorus()
    r = reporter(cfg, fake)
    t = rec(requested_turn_uuid="pending-9")
    run(r.start(t))
    assert fake.bodies("/api/daemon/turn-advance")[0]["turnUuid"] == "pending-9"
    assert t.turn_uuid == "pending-9"


def test_user_interrupt_reports_interrupt(cfg):
    fake = FakeChorus()
    r = reporter(cfg, fake)
    t = rec()

    async def go():
        await r.start(t)
        await r.finish(t, "interrupted", "user")

    run(go())
    terminal = fake.bodies("/api/daemon/turn-advance")[-1]
    assert terminal["status"] == "interrupted" and terminal["interruptedReason"] == "user"
    assert "wakeError" not in terminal
    assert fake.bodies("/api/daemon/report-interrupt") == [
        {"connectionUuid": "c-1", "entityType": "task", "entityUuid": "t-1", "reason": "user"}]
    assert fake.paths().index("/api/daemon/report-interrupt") > len(fake.paths()) - 3


def test_crash_carries_strict_wake_error_and_usage(cfg):
    fake = FakeChorus()
    r = reporter(cfg, fake)
    t = rec()
    t.usage.add({"input_tokens": 10, "output_tokens": 5, "cache_read_tokens": 2, "cache_write_tokens": 1}, "m-1")

    async def go():
        await r.start(t)
        await r.finish(t, "interrupted", "crash",
                       r.wake_error("x" * 900 + " Bearer abc " + "cho_" + "supersecretvalue1234", details="d"))

    run(go())
    terminal = fake.bodies("/api/daemon/turn-advance")[-1]
    err = terminal["wakeError"]
    assert set(err) == {"kind", "source", "message", "details", "exitCode", "signal"}
    assert err["kind"] == "execution" and err["source"] == "hermes" and len(err["message"]) <= 500
    assert terminal["usage"] == {"inputTokens": 10, "outputTokens": 5, "cacheCreationTokens": 1,
                                 "cacheReadTokens": 2, "model": "m-1", "source": "hermes"}
    assert fake.bodies("/api/daemon/report-interrupt")[0]["reason"] == "crash"


def test_crash_without_error_gets_default_wake_error(cfg):
    fake = FakeChorus()
    r = reporter(cfg, fake)
    t = rec()

    async def go():
        await r.start(t)
        await r.finish(t, "interrupted", "crash")

    run(go())
    assert fake.bodies("/api/daemon/turn-advance")[-1]["wakeError"]["message"] == "Hermes agent turn failed"


def test_shutdown_has_no_report_interrupt(cfg):
    fake = FakeChorus()
    r = reporter(cfg, fake)
    t = rec()

    async def go():
        await r.start(t)
        await r.finish(t, "interrupted", "shutdown")
        await r.finish(t, "ended")  # idempotent

    run(go())
    assert fake.bodies("/api/daemon/turn-advance")[-1]["interruptedReason"] == "shutdown"
    assert len(fake.bodies("/api/daemon/turn-advance")) == 2
    assert "/api/daemon/report-interrupt" not in fake.paths()


def test_wake_error_sanitizes_and_bounds():
    err = make_wake_error("line1\n\x1b[31mred\x1b[0m token=abc123 Authorization: Bearer xyz cho_abcdefgh "
                          + "y" * 600, secrets=("s3cret",), details="s3cret here")
    assert len(err["message"]) <= 500 and "\n" not in err["message"]
    assert "abc123" not in err["message"] and "xyz" not in err["message"] and "cho_abcdefgh" not in err["message"]
    assert "\x1b" not in err["message"]
    assert err["details"] == "[redacted] here"
    assert make_wake_error("", kind="bogus") == {"kind": "execution", "source": "hermes",
                                                 "message": "Hermes agent wake failed", "details": None,
                                                 "exitCode": None, "signal": None}


def test_rest_failures_are_logged_not_raised(cfg, caplog):
    fake = FakeChorus()
    fake.fail_paths |= {"/api/daemon/turn-advance", "/api/daemon/execution-state", "/api/daemon/transcript",
                        "/api/daemon/report-interrupt", "/api/daemon/pending-turns"}
    r = reporter(cfg, fake)
    t = rec()

    async def go():
        await r.start(t)
        await r.transcript(t, "assistant", "x")
        await r.finish(t, "interrupted", "user")
        return await r.pending_turns()

    assert run(go()) == []
    assert t.turn_uuid is None
    assert "failed" in caplog.text
    # nothing is attributed to "the session's latest turn" without an admitted turn
    assert fake.bodies("/api/daemon/transcript") == []
    assert fake.bodies("/api/daemon/report-interrupt") == []
    assert fake.bodies("/api/daemon/execution-state") == []


def test_transport_exceptions_are_swallowed(cfg):
    def boom(request):
        raise httpx.ConnectError("down")

    r = TurnReporter(ChorusRest(cfg, async_transport=httpx.MockTransport(boom)), lambda: "c-1")
    t = rec()

    async def go():
        await r.start(t)
        await r.finish(t, "ended")

    run(go())  # no exception


def test_no_connection_skips_reports(cfg):
    fake = FakeChorus()
    r = reporter(cfg, fake, conn=None)
    t = rec()

    async def go():
        await r.start(t)
        await r.finish(t, "ended")

    run(go())
    assert fake.calls == []


def test_close_unstarted_admits_and_ends(cfg):
    fake = FakeChorus()
    r = reporter(cfg, fake)
    t = rec(requested_turn_uuid="p-1")
    run(r.close_unstarted(t))
    assert [b["status"] for b in fake.bodies("/api/daemon/turn-advance")] == ["running", "ended"]


# -- admission (B2-start-without-admission) ------------------------------------------------


def _admit(cfg, fake, conn="c-1", **kw):
    r = reporter(cfg, fake, conn=conn)
    t = rec(**kw)
    return run(r.start(t)), t, r


def test_admission_rejected_on_404_and_409(cfg):
    from .fixtures.chorus_fake import error

    for status in (404, 409, 400):
        fake = FakeChorus()
        fake.turn_advance_hook = lambda body, s=status: error(s, "Invalid turn transition ended → running")
        admission, t, r = _admit(cfg, fake, requested_turn_uuid="tu-1")
        assert admission.status == "rejected" and not admission.admitted and admission.http_status == status
        assert t.turn_uuid is None and r.executions == {}
        assert fake.bodies("/api/daemon/execution-state") == []


def test_admission_unavailable_on_5xx_network_and_no_connection(cfg):
    from .fixtures.chorus_fake import error

    def down(body):
        raise httpx.ConnectError("down")

    for hook in (lambda body: error(503), lambda body: error(429), down):
        fake = FakeChorus()
        fake.turn_advance_hook = hook
        admission, t, r = _admit(cfg, fake)
        assert admission.status == "unavailable" and t.turn_uuid is None and r.executions == {}
        assert fake.bodies("/api/daemon/execution-state") == []
    fake = FakeChorus()
    admission, t, _ = _admit(cfg, fake, conn=None)
    assert admission.status == "unavailable" and fake.calls == []


def test_admission_for_a_different_turn_is_rejected(cfg):
    from .fixtures.chorus_fake import envelope

    fake = FakeChorus()
    fake.turn_advance_hook = lambda body: envelope({"turn": {"uuid": "someone-elses", "status": "running"}})
    admission, t, _ = _admit(cfg, fake, requested_turn_uuid="tu-1")
    assert admission.status == "rejected" and t.turn_uuid is None


def test_admitted_turn_marks_running(cfg):
    fake = FakeChorus()
    admission, t, r = _admit(cfg, fake, requested_turn_uuid="tu-1")
    assert admission.admitted and admission.turn_uuid == "tu-1" == t.turn_uuid
    assert r.executions["task:t-1"]["status"] == "running"
