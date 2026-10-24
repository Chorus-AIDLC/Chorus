"""Admission proof validation and request-local HTTP propagation."""

import asyncio
import json

import httpx
import pytest

from chorus_hermes.mcp_client import ChorusMcpClient
from chorus_hermes.rest import ChorusRest
from chorus_hermes.turn_context import TurnProof, valid_wake_context

TURN = "11111111-1111-4111-8111-111111111111"
ADMISSION = "22222222-2222-4222-8222-222222222222"
OTHER = "33333333-3333-4333-8333-333333333333"


def wake_context():
    fence = {"ideaUuid": TURN, "generation": 2, "ownerUuid": ADMISSION,
             "agentUuid": OTHER, "role": "orchestrator"}
    return {"version": 1, "notificationUuid": "note", "notification": {
        "uuid": "note", "action": "team_lead_handoff", "entityType": "proposal", "entityUuid": "proposal",
        "projectUuid": "project", "entityTitle": "Proposal", "message": "review", "actorName": "Human",
        "actorType": "user", "actorUuid": "human"}, "ideaTeam": fence,
        "ideaTeams": [fence.copy(), {**fence, "ideaUuid": OTHER, "role": "product"}]}


def test_supplementary_proofs_are_explicit_and_bounded():
    pair = {"turnUuid": OTHER, "admissionUuid": ADMISSION}
    headers = TurnProof(TURN, ADMISSION, (pair,) * 16).headers()
    assert json.loads(headers["X-Chorus-Idea-Team-Turns"]) == [pair] * 16
    assert len(headers["X-Chorus-Idea-Team-Turns"]) <= 4096
    assert "X-Chorus-Idea-Team-Turns" not in TurnProof(TURN, ADMISSION).headers()
    with pytest.raises(ValueError):
        TurnProof(TURN, ADMISSION, (pair,) * 17).headers()


@pytest.mark.parametrize("pair", [{"turnUuid": TURN}, {"turnUuid": TURN, "admissionUuid": "bad"},
    {"turnUuid": TURN, "admissionUuid": ADMISSION, "generation": 2}, "bad", None])
def test_invalid_supplementary_proofs_fail_closed(pair):
    with pytest.raises(ValueError):
        TurnProof(TURN, ADMISSION, (pair,)).headers()


@pytest.mark.parametrize("value", [None, "", "turn", TURN + "\n", "{" + TURN + "}"])
def test_primary_uuid_validation(value):
    with pytest.raises(ValueError):
        TurnProof(value, ADMISSION).headers()


@pytest.mark.parametrize("version", [True, False, None, "1", 0, 2])
def test_malformed_wake_context_version_fails_closed(version):
    assert not valid_wake_context({**wake_context(), "version": version})
    context = wake_context()
    del context["version"]
    assert not valid_wake_context(context)


def test_all_source_fences_are_validated():
    context = wake_context()
    assert valid_wake_context(context)
    context["ideaTeams"][1]["generation"] = True
    assert not valid_wake_context(context)
    context = wake_context()
    context["ideaTeams"] = context["ideaTeams"][1:]
    assert not valid_wake_context(context)
    context = wake_context()
    context["ideaTeam"]["agentUuid"] = "bad"
    assert not valid_wake_context(context)


def test_sync_async_rest_and_mcp_headers_are_request_local(cfg):
    requests = []

    def respond(request):
        requests.append(request)
        if request.url.path == "/api/mcp":
            return httpx.Response(200, json={"result": {"content": [{"type": "text", "text": "{}"}]}})
        return httpx.Response(200, json={"success": True, "data": {}})

    transport = httpx.MockTransport(respond)
    mcp = ChorusMcpClient(cfg, transport=transport, async_transport=transport)
    rest = ChorusRest(cfg, transport=transport, async_transport=transport)
    proof = TurnProof(TURN, ADMISSION, ({"turnUuid": OTHER, "admissionUuid": ADMISSION},))
    mcp.call_tool("chorus_pm_create_proposal", {}, turn_proof=proof)
    rest.post("/api/proposals", {}, turn_proof=proof)

    async def run():
        await asyncio.gather(mcp.acall_tool("chorus_get_task", {}, turn_proof=proof),
                             mcp.acall_tool("chorus_get_task", {}),
                             rest.apost("/api/proposals", {}, turn_proof=proof),
                             rest.apost("/api/proposals", {}))

    asyncio.run(run())
    mcp.call_tool("chorus_get_task", {})
    rest.post("/api/proposals", {})
    assert sum("X-Chorus-Turn-Uuid" in request.headers for request in requests) == 4
    for request in requests:
        if "X-Chorus-Turn-Uuid" in request.headers:
            assert request.headers["X-Chorus-Turn-Uuid"] == TURN
            assert request.headers["X-Chorus-Admission-Uuid"] == ADMISSION
            assert json.loads(request.headers["X-Chorus-Idea-Team-Turns"])[0]["turnUuid"] == OTHER
