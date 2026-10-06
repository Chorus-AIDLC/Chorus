"""router.py: every skip rule of cli/event-router.mjs, dedup, pending turns, control."""

from __future__ import annotations

import asyncio

import httpx
import pytest

from chorus_hermes.mcp_client import ChorusMcpClient
from chorus_hermes.prompts import WAKE_ACTIONS, build_prompt
from chorus_hermes.rest import ChorusRest
from chorus_hermes.router import (EventRouter, LineageResolver, WakeRequest, chat_id_for,
                                  entity_for_chat_id)
from chorus_hermes.turns import TurnReporter

from .fixtures.chorus_fake import FakeChorus


def run(coro):
    return asyncio.run(coro)


def notif(uuid="n-1", action="task_assigned", **kw):
    base = {"uuid": uuid, "action": action, "projectUuid": "p-1", "entityType": "task", "entityUuid": "t-1",
            "entityTitle": "T", "message": "m", "actorType": "user", "actorUuid": "u-1", "actorName": "Ann"}
    base.update(kw)
    return base


@pytest.fixture
def setup(cfg):
    fake = FakeChorus()
    transport = httpx.MockTransport(fake)
    rest = ChorusRest(cfg, async_transport=transport)
    dispatched = []
    me = {"uuid": "c-me"}
    turns = TurnReporter(rest, lambda: me["uuid"])
    router = EventRouter(mcp=ChorusMcpClient(cfg, async_transport=transport), lineage=LineageResolver(rest),
                         dispatch=dispatched.append, get_connection_uuid=lambda: me["uuid"],
                         pending_turns=turns.pending_turns)
    return fake, router, dispatched, me


def event(uuid="n-1", **kw):
    return {"type": "new_notification", "notificationUuid": uuid, **kw}


def test_wake_dispatched_with_reread_and_prompt(setup):
    fake, router, dispatched, _ = setup
    fake.notifications = [notif()]
    fake.lineage["task:t-1"] = ("root-1", "idea-1")
    wake = run(router.handle_notification(event()))
    assert dispatched == [wake]
    assert fake.tool_calls("chorus_get_notifications") == [{"status": "unread", "limit": 50, "autoMarkRead": False}]
    assert wake.chat_id == "idea:idea-1" and wake.session_id == "idea-1" and wake.root_idea_uuid == "root-1"
    assert wake.prompt == build_prompt(notif())
    assert wake.turn_uuid is None


def test_chat_id_falls_back_to_entity(setup):
    fake, router, dispatched, _ = setup
    fake.notifications = [notif()]
    wake = run(router.handle_notification(event()))
    assert wake.chat_id == "task:t-1" and wake.session_id == "t-1"
    assert chat_id_for(None, "task", "t-1") == "task:t-1"
    assert entity_for_chat_id("idea:i-1") == ("idea", "i-1") and entity_for_chat_id("bad") is None


def test_dedup_by_notification_uuid(setup):
    fake, router, dispatched, _ = setup
    fake.notifications = [notif()]
    run(router.handle_notification(event()))
    run(router.handle_notification(event()))
    assert len(dispatched) == 1
    assert len(fake.tool_calls("chorus_get_notifications")) == 1


def test_missing_uuid_and_other_event_types_ignored(setup):
    fake, router, dispatched, _ = setup
    assert run(router.handle_notification({"type": "new_notification"})) is None
    assert run(router.handle_notification({"type": "count_update"})) is None
    assert dispatched == [] and fake.calls == []


def test_not_in_unread_list_skipped(setup):
    fake, router, dispatched, _ = setup
    fake.notifications = [notif("other")]
    run(router.handle_notification(event()))
    assert dispatched == []


@pytest.mark.parametrize("action", ["comment_added", "task_status_changed", "task_submitted_for_verify",
                                    "report_created"])
def test_non_wake_actions_skipped(setup, action):
    fake, router, dispatched, _ = setup
    fake.notifications = [notif(action=action)]
    run(router.handle_notification(event()))
    assert dispatched == []
    assert "not a wake action" in router.skipped[-1][1]


@pytest.mark.parametrize("action", ["human_instruction", "idea_creation_requested", "research_requested"])
def test_human_instruction_and_operations_only_via_pending_turns(setup, action):
    fake, router, dispatched, _ = setup
    fake.notifications = [notif(action=action, instructionText="do it")]
    run(router.handle_notification(event()))
    assert dispatched == []
    assert "pending turns only" in router.skipped[-1][1]


def test_suppress_wake_skipped(setup):
    fake, router, dispatched, _ = setup
    fake.notifications = [notif()]
    run(router.handle_notification(event(suppressWake=True)))
    assert dispatched == [] and "suppressWake" in router.skipped[-1][1]


def test_directed_to_other_connection_skipped(setup):
    fake, router, dispatched, _ = setup
    fake.notifications = [notif()]
    run(router.handle_notification(event(targetConnectionUuid="c-other")))
    assert dispatched == [] and "directed to connection c-other" in router.skipped[-1][1]


def test_directed_before_registration_skipped(setup):
    fake, router, dispatched, me = setup
    me["uuid"] = None
    fake.notifications = [notif()]
    run(router.handle_notification(event(targetConnectionUuid="c-me")))
    assert dispatched == []


def test_directed_to_me_wakes(setup):
    fake, router, dispatched, _ = setup
    fake.notifications = [notif()]
    run(router.handle_notification(event(targetConnectionUuid="c-me")))
    assert len(dispatched) == 1


def test_every_wake_action_except_pending_only_is_routable(setup):
    fake, router, dispatched, _ = setup
    routable = WAKE_ACTIONS - {"human_instruction", "idea_creation_requested", "research_requested",
                               "resource_resumed"}
    fake.notifications = [notif(f"n-{a}", action=a) for a in sorted(routable)]
    for a in sorted(routable):
        run(router.handle_notification(event(f"n-{a}")))
    assert sorted(w.action for w in dispatched) == sorted(routable)


def test_pre_dispatch_filter_consumes_any_action(setup):
    fake, router, dispatched, _ = setup
    seen = []

    async def approval_filter(wake: WakeRequest) -> bool:
        seen.append((wake.source, wake.action, wake.transport))
        return wake.action == "comment_added" or wake.notification.get("message") == "approve once ABC123"

    router.add_pre_dispatch_filter(approval_filter)
    fake.notifications = [notif("n-1", action="comment_added"),
                          notif("n-2", action="mentioned", message="approve once ABC123"),
                          notif("n-3", action="mentioned", message="hello")]
    for uuid in ("n-1", "n-2", "n-3"):
        run(router.handle_notification(event(uuid)))
    assert [w.notification["uuid"] for w in dispatched] == ["n-3"]
    assert seen[0] == ("notification", "comment_added", {"targetConnectionUuid": None, "suppressWake": False})


def test_filter_errors_do_not_block(setup):
    fake, router, dispatched, _ = setup
    router.add_pre_dispatch_filter(lambda w: 1 / 0)
    fake.notifications = [notif()]
    run(router.handle_notification(event()))
    assert len(dispatched) == 1


# -- pending turns -------------------------------------------------------------------


def test_pending_human_instruction_uses_prompt_text_and_turn_uuid(setup):
    fake, router, dispatched, _ = setup
    fake.pending = [{"turnUuid": "tu-1", "sessionId": "i-1", "directIdeaUuid": "i-1",
                     "trigger": "human_instruction", "promptText": "  rebase please "}]
    run(router.sweep_pending_turns())
    (wake,) = dispatched
    assert fake.calls[0][2] == {"connectionUuid": "c-me"}
    assert wake.turn_uuid == "tu-1" and wake.chat_id == "idea:i-1" and wake.prompt_text == "  rebase please "
    assert "rebase please" in wake.prompt
    run(router.sweep_pending_turns())  # seen: not re-run
    assert len(dispatched) == 1


def test_pending_ad_hoc_session_anchors_on_daemon_session(setup):
    fake, router, dispatched, _ = setup
    fake.pending = [{"turnUuid": "tu-2", "sessionId": "s-9", "directIdeaUuid": None,
                     "trigger": "human_instruction", "promptText": "hi"}]
    run(router.sweep_pending_turns())
    assert dispatched[0].chat_id == "daemon_session:s-9"


def test_pending_autonomous_rebuilds_from_notification_and_dedups_broadcast(setup):
    fake, router, dispatched, _ = setup
    fake.notifications = [notif("n-5", action="mentioned", entityType="idea", entityUuid="i-1")]
    fake.pending = [{"turnUuid": "tu-3", "sessionId": "i-1", "directIdeaUuid": "i-1", "trigger": "mentioned",
                     "promptText": None}]
    run(router.sweep_pending_turns())
    (wake,) = dispatched
    assert wake.turn_uuid == "tu-3" and wake.notification["uuid"] == "n-5"
    run(router.handle_notification(event("n-5")))  # broadcast copy arrives later
    assert len(dispatched) == 1


def test_pending_autonomous_searches_read_notifications(setup):
    # The connect-time chorus_checkin may already have marked the backing notification read;
    # the pending turn must still be rebuilt from it.
    fake, router, dispatched, _ = setup
    fake.notifications = [notif("n-6", action="mentioned", entityType="idea", entityUuid="i-2")]
    fake.pending = [{"turnUuid": "tu-4", "sessionId": "i-2", "directIdeaUuid": "i-2", "trigger": "mentioned",
                     "promptText": None}]
    run(router.sweep_pending_turns())
    assert [w.turn_uuid for w in dispatched] == ["tu-4"]
    assert {"status": "all", "limit": 50, "autoMarkRead": False} in fake.tool_calls("chorus_get_notifications")


def test_pending_only_turn_filter_and_unknown_trigger(setup):
    fake, router, dispatched, _ = setup
    fake.pending = [{"turnUuid": "a", "sessionId": "s", "trigger": "human_instruction", "promptText": "x"},
                    {"turnUuid": "b", "sessionId": "s", "trigger": "human_instruction", "promptText": "y"},
                    {"turnUuid": "c", "sessionId": "s", "trigger": "elaboration", "promptText": None}]
    run(router.sweep_pending_turns("b"))
    assert [w.turn_uuid for w in dispatched] == ["b"]
    run(router.sweep_pending_turns())
    assert [w.turn_uuid for w in dispatched] == ["b", "a"]


def test_pending_turn_filter_hook(setup):
    fake, router, dispatched, _ = setup
    router.add_pre_dispatch_filter(lambda w: w.source == "pending_turn")
    fake.pending = [{"turnUuid": "a", "sessionId": "s", "trigger": "human_instruction", "promptText": "x"}]
    run(router.sweep_pending_turns())
    assert dispatched == []


# -- control ---------------------------------------------------------------------------


def test_control_only_for_my_connection(setup):
    fake, router, dispatched, _ = setup
    interrupted = []
    router.control_hooks.update(is_running=lambda t, u: True, interrupt=lambda t, u: interrupted.append((t, u)))
    ev = {"type": "control", "command": "interrupt", "entityType": "task", "entityUuid": "t-1"}
    assert run(router.handle_control({**ev, "targetConnectionUuid": "c-other"})) is None
    assert run(router.handle_control(ev)) is None  # no target
    assert run(router.handle_control({**ev, "targetConnectionUuid": "c-me"})) == "interrupt"
    assert interrupted == [("task", "t-1")]


def test_control_interrupt_ignored_when_not_running(setup):
    _, router, _, _ = setup
    router.control_hooks.update(is_running=lambda t, u: False, interrupt=lambda t, u: 1 / 0)
    ev = {"type": "control", "command": "interrupt", "targetConnectionUuid": "c-me", "entityType": "task",
          "entityUuid": "t-1"}
    assert run(router.handle_control(ev)) is None


def test_control_deliver_turn_sweeps_that_turn(setup):
    fake, router, dispatched, _ = setup
    fake.pending = [{"turnUuid": "a", "sessionId": "s", "trigger": "human_instruction", "promptText": "x"},
                    {"turnUuid": "b", "sessionId": "s", "trigger": "human_instruction", "promptText": "y"}]
    run(router.handle_control({"type": "control", "command": "deliver_turn", "targetConnectionUuid": "c-me",
                               "turnUuid": "b"}))
    assert [w.turn_uuid for w in dispatched] == ["b"]


def test_control_resume_dispatches_resource_resumed(setup):
    fake, router, dispatched, _ = setup
    fake.lineage["task:t-1"] = ("r", "i-1")
    run(router.handle_control({"type": "control", "command": "resume", "targetConnectionUuid": "c-me",
                               "entityType": "task", "entityUuid": "t-1", "resumeReason": "crash"}))
    (wake,) = dispatched
    assert wake.action == "resource_resumed" and wake.chat_id == "idea:i-1"
    assert "EXITED ABNORMALLY" in wake.prompt


def test_control_unknown_command_ignored(setup):
    _, router, dispatched, _ = setup
    assert run(router.handle_control({"type": "control", "command": "reboot", "targetConnectionUuid": "c-me"})) \
        is None


def test_lineage_failure_falls_back_to_entity(setup):
    fake, router, dispatched, _ = setup
    fake.fail_paths.add("/api/entities/task/t-1/root-idea")
    fake.notifications = [notif()]
    wake = run(router.handle_notification(event()))
    assert wake.chat_id == "task:t-1"


# -- pending-turn replay must stay in its own session (B2-cross-idea-notification-fallback) ----


TURN_A = {"turnUuid": "turn-A", "sessionId": "idea-A", "directIdeaUuid": "idea-A", "trigger": "mentioned",
          "promptText": None, "createdAt": "2026-10-05T10:00:00Z"}


def test_pending_turn_never_borrows_another_ideas_notification(setup):
    """Leo's repro: the only `mentioned` candidate is Idea B's (old, already read) notification."""
    fake, router, dispatched, _ = setup
    fake.notifications = [notif("notification-B", action="mentioned", entityType="idea", entityUuid="idea-B",
                                createdAt="2026-10-06T10:00:00Z")]
    fake.lineage["idea:idea-B"] = ("idea-B", "idea-B")
    fake.pending = [dict(TURN_A)]
    run(router.sweep_pending_turns())
    assert dispatched == []
    # left recoverable: not marked handled, so a later sweep looks again
    assert "turn:turn-A" not in router.seen and "notification-B" not in router.seen
    fake.notifications.append(notif("notification-A", action="mentioned", entityType="idea", entityUuid="idea-A",
                                    createdAt="2026-10-05T09:59:59.500Z"))
    run(router.sweep_pending_turns())
    (wake,) = dispatched
    assert wake.notification["uuid"] == "notification-A"
    assert wake.session_id == "idea-A" and wake.chat_id == "idea:idea-A" and wake.turn_uuid == "turn-A"


def test_pending_turn_without_created_at_needs_a_lineage_match_too(setup):
    fake, router, dispatched, _ = setup
    fake.notifications = [notif("n-B", action="mentioned", entityType="idea", entityUuid="idea-B")]
    fake.lineage["idea:idea-B"] = ("idea-B", "idea-B")
    fake.pending = [{k: v for k, v in TURN_A.items() if k != "createdAt"}]
    run(router.sweep_pending_turns())
    assert dispatched == [] and "turn:turn-A" not in router.seen


def test_pending_turn_keeps_its_canonical_session(setup):
    """The notification's entity (a task) or its lineage never re-derives the pending turn's session."""
    fake, router, dispatched, _ = setup
    fake.notifications = [notif("n-t", action="task_assigned", entityType="task", entityUuid="t-9")]
    fake.lineage["task:t-9"] = ("root-X", "idea-X")  # lineage would move the session to idea-X
    fake.pending = [{"turnUuid": "tu-t", "sessionId": "t-9", "directIdeaUuid": None, "trigger": "task_assigned",
                     "promptText": None}]
    run(router.sweep_pending_turns())
    (wake,) = dispatched
    assert wake.session_id == "t-9" and wake.chat_id == "task:t-9" and wake.direct_idea_uuid is None
    assert wake.root_idea_uuid == "root-X"


def test_pending_turn_for_a_task_of_its_idea_uses_the_idea_session(setup):
    fake, router, dispatched, _ = setup
    fake.notifications = [notif("n-t", action="task_assigned", entityType="task", entityUuid="t-1")]
    fake.lineage["task:t-1"] = ("idea-A", "idea-A")
    fake.pending = [{"turnUuid": "tu-1", "sessionId": "idea-A", "directIdeaUuid": "idea-A",
                     "trigger": "task_assigned", "promptText": None}]
    run(router.sweep_pending_turns())
    (wake,) = dispatched
    assert wake.session_id == "idea-A" and wake.entity_uuid == "t-1" and wake.chat_id == "idea:idea-A"


def test_pending_turn_pages_back_for_its_notification(setup):
    fake, router, dispatched, _ = setup
    others = [notif(f"n-{i}", action="mentioned", entityType="idea", entityUuid="idea-B") for i in range(50)]
    mine = notif("n-A", action="mentioned", entityType="idea", entityUuid="idea-A")
    fake.lineage["idea:idea-B"] = ("idea-B", "idea-B")

    def paged(args):
        offset = args.get("offset", 0)
        return {"notifications": (others + [mine])[offset:offset + args["limit"]]}

    fake.tools["chorus_get_notifications"] = paged
    fake.pending = [{k: v for k, v in TURN_A.items() if k != "createdAt"}]
    run(router.sweep_pending_turns())
    (wake,) = dispatched
    assert wake.notification["uuid"] == "n-A"
    assert [c.get("offset", 0) for c in fake.tool_calls("chorus_get_notifications")] == [0, 50]


def test_inexact_page_one_match_does_not_shadow_exact_match_on_page_two(setup):
    """Review note: an older out-of-window same-session notification on page 1 must not win over the
    turn's exact (createdAt-correlated) notification on page 2."""
    fake, router, dispatched, _ = setup
    old_a = notif("old-A", action="mentioned", entityType="idea", entityUuid="idea-A",
                  createdAt="2026-10-01T09:00:00.000Z")
    fillers = [notif(f"n-{i}", action="mentioned", entityType="idea", entityUuid="idea-B",
                     createdAt="2026-10-06T11:00:00.000Z") for i in range(49)]
    exact_a = notif("exact-A", action="mentioned", entityType="idea", entityUuid="idea-A",
                    createdAt="2026-10-06T10:00:00.000Z")
    fake.lineage["idea:idea-B"] = ("idea-B", "idea-B")
    pages = [old_a] + fillers + [exact_a]

    def paged(args):
        offset = args.get("offset", 0)
        return {"notifications": pages[offset:offset + args["limit"]]}

    fake.tools["chorus_get_notifications"] = paged
    fake.pending = [{"turnUuid": "tu-x", "sessionId": "idea-A", "directIdeaUuid": "idea-A",
                     "trigger": "mentioned", "promptText": None, "createdAt": "2026-10-06T10:00:00.200Z"}]
    run(router.sweep_pending_turns())
    (wake,) = dispatched
    assert wake.notification["uuid"] == "exact-A"
    assert wake.transport.get("exactNotification") is True


# -- dedup must not be poisoned by a failed re-read (B2-failed-fetch-poisons-dedup) -------------


def test_failed_reread_does_not_poison_the_pending_turn(setup):
    """Leo's repro: the first sweep's notification re-read fails (503); the second must re-read and dispatch."""
    fake, router, dispatched, _ = setup
    fetches = []

    def flaky(args):
        fetches.append(args)
        if len(fetches) == 1:
            raise RuntimeError("temporary 503")
        return {"notifications": [notif("n-A", action="mentioned", entityType="idea", entityUuid="idea-A",
                                        createdAt="2026-10-05T10:00:00Z")]}

    fake.tools["chorus_get_notifications"] = flaky
    fake.pending = [dict(TURN_A)]
    run(router.sweep_pending_turns())
    assert dispatched == [] and "turn:turn-A" not in router.seen and not router.inflight
    run(router.sweep_pending_turns())
    assert len(fetches) == 2 and [w.turn_uuid for w in dispatched] == ["turn-A"]
    run(router.sweep_pending_turns())  # handled now: no third dispatch
    assert len(dispatched) == 1


def test_concurrent_duplicate_pending_turn_dispatches_once(setup):
    fake, router, dispatched, _ = setup
    fake.notifications = [notif("n-A", action="mentioned", entityType="idea", entityUuid="idea-A",
                                createdAt="2026-10-05T10:00:00Z")]

    async def go():
        return await asyncio.gather(*(router.dispatch_pending_turn(dict(TURN_A)) for _ in range(3)))

    results = run(go())
    assert len(dispatched) == 1 and sum(r is not None for r in results) == 1
    assert len(fake.tool_calls("chorus_get_notifications")) == 1


def test_failed_live_reread_is_recovered_by_the_pending_sweep(setup):
    fake, router, dispatched, _ = setup
    calls = []

    def flaky(args):
        calls.append(args)
        if len(calls) == 1:
            raise RuntimeError("temporary 503")
        return {"notifications": [notif("n-A", action="mentioned", entityType="idea", entityUuid="idea-A")]}

    fake.tools["chorus_get_notifications"] = flaky
    assert run(router.handle_notification(event("n-A"))) is None
    assert "n-A" not in router.seen and not router.inflight
    fake.pending = [{k: v for k, v in TURN_A.items() if k != "createdAt"}]
    run(router.sweep_pending_turns())
    assert [w.notification["uuid"] for w in dispatched] == ["n-A"]


def test_release_makes_a_dispatched_wake_routable_again(setup):
    fake, router, dispatched, _ = setup
    fake.notifications = [notif("n-A", action="mentioned", entityType="idea", entityUuid="idea-A")]
    fake.pending = [{k: v for k, v in TURN_A.items() if k != "createdAt"}]
    run(router.sweep_pending_turns())
    (wake,) = dispatched
    run(router.sweep_pending_turns())
    assert len(dispatched) == 1
    router.release(wake)  # e.g. turn admission was unavailable
    run(router.sweep_pending_turns())
    assert len(dispatched) == 2


def test_live_copy_already_read_leaves_its_pending_turn_replayable(setup):
    fake, router, dispatched, _ = setup
    fake.notifications = []  # the unread re-read no longer lists it (a check-in marked it read)
    assert run(router.handle_notification(event("n-A"))) is None
    fake.notifications = [notif("n-A", action="mentioned", entityType="idea", entityUuid="idea-A")]
    fake.pending = [{k: v for k, v in TURN_A.items() if k != "createdAt"}]
    run(router.sweep_pending_turns())
    assert [w.notification["uuid"] for w in dispatched] == ["n-A"]
