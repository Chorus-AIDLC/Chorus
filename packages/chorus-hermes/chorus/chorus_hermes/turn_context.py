"""Explicit, request-local admission proofs; never stored in transport defaults."""

from __future__ import annotations

import json
import re
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Mapping

_UUID = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
active_run = ContextVar("chorus_admitted_run", default=None)


def valid_uuid(value) -> bool:
    return isinstance(value, str) and _UUID.fullmatch(value) is not None


@dataclass(frozen=True)
class TurnProof:
    turn_uuid: str
    admission_uuid: str
    supplementary_turns: tuple = ()

    def headers(self) -> dict:
        if not valid_uuid(self.turn_uuid) or not valid_uuid(self.admission_uuid):
            raise ValueError("Admission proof requires strict turn/admission UUIDs")
        headers = {"X-Chorus-Turn-Uuid": self.turn_uuid, "X-Chorus-Admission-Uuid": self.admission_uuid}
        if self.supplementary_turns:
            if len(self.supplementary_turns) > 16:
                raise ValueError("At most 16 supplementary admission proofs are allowed")
            pairs = []
            for pair in self.supplementary_turns:
                if not isinstance(pair, Mapping) or set(pair) != {"turnUuid", "admissionUuid"} \
                        or not all(valid_uuid(value) for value in pair.values()):
                    raise ValueError("Supplementary proofs require strict turn/admission UUID pairs")
                pairs.append(dict(pair))
            encoded = json.dumps(pairs, separators=(",", ":"))
            if len(encoded) > 4096:
                raise ValueError("Supplementary admission proofs exceed 4096 characters")
            headers["X-Chorus-Idea-Team-Turns"] = encoded
        return headers


def valid_wake_context(context) -> bool:
    if not isinstance(context, Mapping) or isinstance(context.get("version"), bool) or context.get("version") != 1:
        return False
    notification = context.get("notification")
    if not isinstance(notification, Mapping) or not notification.get("uuid") \
            or notification.get("uuid") != context.get("notificationUuid"):
        return False

    def valid_fence(fence):
        return isinstance(fence, Mapping) and all(valid_uuid(fence.get(key)) for key in
            ("ideaUuid", "ownerUuid", "agentUuid")) and type(fence.get("generation")) is int \
            and fence["generation"] >= 0 and fence.get("role") in ("orchestrator", "product")

    primary = context.get("ideaTeam")
    if "ideaTeam" in context and not valid_fence(primary):
        return False
    if "ideaTeams" in context:
        fences = context["ideaTeams"]
        if not isinstance(fences, list) or not fences or primary not in fences \
                or not all(valid_fence(fence) for fence in fences):
            return False
    return True
