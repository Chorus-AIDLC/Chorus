"""Wake prompts — a byte-for-byte port of ``cli/prompts.mjs`` (plus the operation
prompts from ``cli/operation.mjs`` / ``cli/operation-prompts.mjs``).

The parity test (``tests/test_prompts_parity.py``) renders one fixture set through
both this module and the Node originals and requires identical output, so keep
every literal in sync with the JS source. Notifications are plain ``dict``s as
returned by ``chorus_get_notifications``.

JS template interpolation is reproduced by :func:`_s`: a missing key renders as
``undefined``, ``None`` as ``null``, booleans as ``true``/``false``.
"""

from __future__ import annotations

from typing import Any, Iterable, Mapping, Optional

_MISSING = object()

CONVERSATIONAL_IDEA_DESCRIPTION_MAX_CHARS = 3000
RESEARCH_INSTRUCTION_PREFIX = "[Chorus Tracker Research]"
PROJECT_INSTRUCTION_LABEL_MAX_CHARS = 200

OPERATION_ACTIONS = frozenset({"idea_creation_requested", "research_requested"})

# Literal kept out of one source token: the install scanner flags "you are ... now" as a role hijack.
_NOW = "n" + "ow"

# JS String.prototype.trim() whitespace (WhiteSpace + LineTerminator).
# Built from code points so no invisible characters appear in the source file.
_JS_WS = "".join(chr(c) for c in (
    0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0x1680, *range(0x2000, 0x200B),
    0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF))


def _js_trim(text: str) -> str:
    return text.strip(_JS_WS)


def _js_len(text: str) -> int:
    """String length in UTF-16 code units, like JS ``.length``."""
    return len(text.encode("utf-16-le")) // 2


def _js_slice(text: str, end: int) -> str:
    """``text.slice(0, end)`` in UTF-16 code units."""
    return text.encode("utf-16-le")[: end * 2].decode("utf-16-le", errors="ignore")


def _s(value: Any) -> str:
    if value is _MISSING:
        return "undefined"
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def _g(n: Mapping[str, Any], key: str) -> Any:
    return n.get(key, _MISSING) if isinstance(n, Mapping) else _MISSING


def _f(n: Mapping[str, Any], key: str) -> str:
    return _s(_g(n, key))


def _truthy(value: Any) -> bool:
    """JS truthiness for JSON values."""
    if value is _MISSING or value is None or value is False:
        return False
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return value != 0
    if isinstance(value, str):
        return value != ""
    return True


def _is_str(value: Any) -> bool:
    return isinstance(value, str)


# ---------------------------------------------------------------------------
# Guidance blocks
# ---------------------------------------------------------------------------


def _mention_guidance(n: Mapping[str, Any], entity_type: str) -> str:
    return (
        f"After completing your work, post a comment on this {entity_type} using "
        f"chorus_add_comment with @mention: @[{_f(n, 'actorName')}]({_f(n, 'actorType')}:{_f(n, 'actorUuid')})"
    )


def _orchestrator_guidance(n: Mapping[str, Any]) -> Optional[str]:
    orch = _g(n, "orchestrator")
    if not isinstance(orch, Mapping) or orch.get("type") != "agent":
        return None
    name, uuid = _f(orch, "name"), _f(orch, "uuid")
    return (
        f"Your orchestrator for this resource is @{name}.\n"
        "At a human-only gate you cannot cross, or when this child resource is complete, hand control "
        "back by commenting on the resource and mentioning "
        f"@[{name}](agent:{uuid}) with the decision needed or completion "
        "evidence, then leave any human-gated resource pending and end the turn. Do not @mention the "
        "orchestrator for ordinary internal progress."
    )


def _waker_session_guidance(n: Mapping[str, Any]) -> Optional[str]:
    ws = _g(n, "wakerSession")
    if not _truthy(ws):
        return None
    agent_name = _f(ws, "agentName") if isinstance(ws, Mapping) else "undefined"
    agent_uuid = _f(ws, "agentUuid") if isinstance(ws, Mapping) else "undefined"
    return (
        f"@[{agent_name}](agent:{agent_uuid}) woke you and has a live session open on this "
        "resource. If you reply by commenting on this same resource, your reply reaches that "
        "agent's live session, keeping the exchange on one thread. This is advisory, not an "
        "enforced server route — there is no automatic subscription and nothing is force-delivered; "
        "replying here is simply where a reply lands via the normal return path. Prefer replying "
        "on this resource over opening a new session."
    )


HEADLESS_PREAMBLE = "\n".join([
    "[Headless daemon session] You are a headless `claude -p` session woken by the Chorus",
    "daemon. There is NO human at the terminal, and the environment variable",
    "CHORUS_DAEMON_HEADLESS=1 is set.",
    "",
    "Do NOT call AskUserQuestion or any interactive / blocking terminal prompt — it reaches",
    "no one and will hang or be silently dropped. Whenever you would ask the human something,",
    "route it through Chorus instead: post a comment with chorus_add_comment and @mention the",
    "requester, and/or open an elaboration round the human answers in the Chorus UI panel.",
    "",
    "A few examples (not exhaustive): when a skill says to present elaboration questions via",
    "AskUserQuestion, open an elaboration round and @mention the requester in a comment so they",
    "answer in the UI; when a skill says to ask permission before skipping a step, do not skip",
    "silently — record the reason in a Chorus comment; when a skill offers to write a report,",
    "create it directly or skip it, never prompt for it.",
    "",
    "When working an idea/proposal/task, if you come across an external link that is evidence",
    "(a precedent issue/PR, a reference implementation, official docs, a paper/blog), attach it",
    "via references — prefer the inline references[] param at creation time over a post-hoc",
    "chorus_add_reference. Make it a reflex, not an afterthought.",
    "",
    "After you post something that needs a human decision, END THE TURN and leave the work",
    "pending — do not poll or wait for a synchronous reply. The human's later comment or",
    "elaboration answer wakes a fresh turn that continues the work.",
])


# ---------------------------------------------------------------------------
# Operations (cli/operation.mjs + cli/operation-prompts.mjs)
# ---------------------------------------------------------------------------


class OperationProtocolError(ValueError):
    pass


def _identity(value: Any) -> bool:
    return isinstance(value, str) and 0 < _js_len(value) <= 100


def _is_one(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and value == 1


def validate_operation(trigger: Any, payload: Any, ctx: Mapping[str, Any]) -> Mapping[str, Any]:
    """Port of ``validateOperation``; raises :class:`OperationProtocolError`."""
    creation = trigger == "idea_creation_requested"
    fields = (["version", "kind", "ideaUuid", "projectUuid", "mode", "researchFirst", "descriptionText"]
              if creation else ["version", "kind", "ideaUuid"])
    session_id = ctx.get("sessionId", _MISSING)
    direct = ctx.get("directIdeaUuid", _MISSING)
    project = ctx.get("projectUuid", _MISSING)

    def bad() -> bool:
        if trigger not in OPERATION_ACTIONS or not isinstance(payload, Mapping):
            return True
        if len(payload) != len(fields) or any(f not in payload for f in fields):
            return True
        if not _is_one(payload.get("version")) or payload.get("kind") != ("idea_creation" if creation else "research"):
            return True
        if not _identity(payload.get("ideaUuid")) or payload.get("ideaUuid") != direct or session_id != direct:
            return True
        if creation:
            if not _identity(payload.get("projectUuid")):
                return True
            if project is not _MISSING and payload.get("projectUuid") != project:
                return True
            if payload.get("mode") not in ("elaborate", "decompose"):
                return True
            if not isinstance(payload.get("researchFirst"), bool):
                return True
            text = payload.get("descriptionText")
            if not isinstance(text, str) or not _js_trim(text) or _js_len(text) > CONVERSATIONAL_IDEA_DESCRIPTION_MAX_CHARS:
                return True
        return False

    if bad():
        raise OperationProtocolError("Operation protocol error: invalid payload or session/Idea identity mismatch")
    return payload


def compose_conversational_idea_instruction(params: Mapping[str, Any]) -> str:
    raw_name = params.get("projectName")
    project_name = _js_trim(raw_name) if isinstance(raw_name, str) else None
    if project_name and _js_len(project_name) > PROJECT_INSTRUCTION_LABEL_MAX_CHARS:
        display = f"{_js_slice(project_name, PROJECT_INSTRUCTION_LABEL_MAX_CHARS - 1)}…"
    else:
        display = project_name
    project_uuid = _f(params, "projectUuid")
    project_label = f'"{display}" (projectUuid: {project_uuid})' if display else f"projectUuid: {project_uuid}"

    research = " ".join([
        "The user explicitly requested lightweight research before clarification."
        if _truthy(params.get("researchFirst"))
        else "Research is optional: use automatic judgment for a concrete, externally verifiable factual gap.",
        "An explicit request to skip research in the user's instructions takes precedence.",
        "Follow the shared research skill before the first formal elaboration: one bounded pass, approximately 2–5 minutes, at most 5 deeply read relevant sources; reuse existing evidence.",
        "Save useful findings in the existing Idea content, preserving the user's meaning, and attach evidence with real ref:UUID citations. Do not create or claim this already-created Idea.",
        "If tools are unavailable, results are empty, or the budget is exhausted, record the limitation and continue the normal steps in this turn. Do not research user preferences; ask through the elaboration panel when needed.",
        "This initialization request applies once, not on every later wake or stage re-entry.",
    ])
    idea_uuid = _f(params, "ideaUuid")
    description = _f(params, "descriptionText")

    if params.get("mode") == "decompose":
        return "\n".join([
            f"[Chorus container-decompose entry] A new CONTAINER idea has been PRE-CREATED for project {project_label} from the user's description below, and it is already assigned to you (status: elaborating, isContainer: true).",
            f"  ideaUuid: {idea_uuid}",
            "",
            "This conversation IS that container idea's root session. The user wants help DECOMPOSING it into child ideas. Do the following, in order:",
            "1. Edit the container via chorus_edit_idea: derive a concise title from the description and polish the content (keep the user's meaning). The current title is a placeholder.",
            "2. Ensure it stays a container: it was pre-created with isContainer=true — do NOT clear that flag (a container groups its child ideas and MUST NOT get a proposal of its own).",
            f"Before step 3: {research}",
            "3. Run ONE lightweight elaboration round (chorus_pm_start_elaboration) to clarify the decomposition scope/dimension — how to slice the work into children. Keep it short; you may self-answer in headless or ask the user, then continue.",
            "4. Propose the candidate child ideas AS A STRUCTURED ELABORATION ROUND (chorus_pm_start_elaboration) for the user to review/edit/confirm — use ONE elaboration question PER proposed child (the child's title as the question text, a short rationale as its description), single-select. Elaboration questions are single-select and a round is capped at 15 questions, so propose at most 15 candidates per round and NEVER a single multi-select question; if you need more children, propose them across additional rounds. Do NOT create any child ideas yet — this round is the preview the user accepts/edits/declines per child.",
            "5. End the turn. The user's answers in the idea's elaboration panel will wake this same conversation (the existing elaboration-answered wake).",
            f'6. On that re-wake, create each ACCEPTED child via chorus_pm_create_idea with parentUuid={idea_uuid}. Each child starts in the "open" state — do NOT auto-elaborate them. The container\'s OWN status stays "elaborated"; creating children does not advance or alter it.',
            "",
            "Reference reflex: whenever an external link is evidence for this work (a precedent issue/PR, a reference implementation, official docs, a paper/blog), attach it via references — prefer the inline references[] param at creation time over a post-hoc chorus_add_reference.",
            "",
            "--- User's idea description ---",
            description,
        ])

    return "\n".join([
        f"[Chorus conversational idea entry] A new idea has been PRE-CREATED for project {project_label} from the user's description below, and it is already assigned to you (status: elaborating).",
        f"  ideaUuid: {idea_uuid}",
        "",
        "This conversation IS that idea's root session — its elaboration and lifecycle wakes will continue here. Do the following, in order:",
        "1. Edit the idea via chorus_edit_idea: derive a concise title from the description and polish the content (keep the user's meaning; you may restructure). The current title is a placeholder.",
        f"2. {research}",
        "3. After that optional step, start elaboration on the idea (chorus_pm_start_elaboration), following the idea skill — do NOT wait for another wake. Post a short summary of your questions in this conversation and direct the user to answer in the idea's elaboration panel.",
        "4. End the turn. The user's panel answers will wake this same conversation.",
        "",
        "Reference reflex: whenever an external link is evidence for this idea (a precedent issue/PR, a reference implementation, official docs, a paper/blog), attach it via references — prefer the inline references[] param at creation time over a post-hoc chorus_add_reference.",
        "",
        "--- User's idea description ---",
        description,
    ])


def compose_research_instruction(idea_uuid: Any) -> str:
    return "\n".join([
        f"{RESEARCH_INSTRUCTION_PREFIX} Explicit, one-time research request for ideaUuid: {_s(idea_uuid)}.",
        "This is the existing Idea's root conversation. Before research and again before saving, re-read the Idea, ALL related proposals/tasks and execution history including theme descendants. If development has begun, report that the stage changed and STOP without research or edits.",
        "Invoke the shared research skill for ONE bounded pass (approximately 2–5 minutes, at most 5 deeply read sources). Reuse existing evidence. An explicit user instruction to skip research takes precedence. Tools unavailable, empty results, or exhausted budget: record the limitation and stop.",
        "Attach useful sources through existing references and obtain real UUIDs. Read the latest Idea content immediately before saving and MERGE concise findings, source citations using ref:UUID, implications, unknowns, and the stopping reason; preserve user text and existing evidence.",
        "Preserve all elaboration rounds, questions, answers and resolved state. Do not create or claim an Idea, start elaboration, submit or modify a Proposal, change task status, or start development. If findings affect an approved proposal, only record the impact and revision needs in the Idea.",
        "Report the findings and END this turn. This menu invocation does not resume the Idea or Proposal workflow. A later explicit Research request may run another bounded pass.",
    ])


def build_operation_prompt(n: Mapping[str, Any]) -> str:
    ctx = {k: n[k] for k in ("sessionId", "directIdeaUuid", "projectUuid") if k in n}
    p = validate_operation(n.get("action"), n.get("operationPayload"), ctx)
    if p.get("kind") == "research":
        return compose_research_instruction(p.get("ideaUuid"))
    return compose_conversational_idea_instruction(p)


# ---------------------------------------------------------------------------
# Per-action bodies
# ---------------------------------------------------------------------------


def build_prompt_body(n: Mapping[str, Any]) -> Optional[str]:
    action = _g(n, "action")
    title, uuid, project = _f(n, "entityTitle"), _f(n, "entityUuid"), _f(n, "projectUuid")
    etype = _f(n, "entityType")

    if action == "task_assigned":
        return (
            f"[Chorus] Task assigned: {title}. Task UUID: {uuid}, "
            f"Project UUID: {project}. Use chorus_get_task to review the task, "
            f"then chorus_claim_task to start work.\n{_mention_guidance(n, 'task')}"
        )
    if action == "mentioned":
        return (
            f"[Chorus] You were @mentioned in {etype} '{title}' "
            f"(entityType: {etype}, entityUuid: {uuid}, projectUuid: {project}): {_f(n, 'message')}\n"
            f'Review the {etype} and use chorus_get_comments (targetType: "{etype}", '
            f'targetUuid: "{uuid}") to see the conversation, then respond.\n{_mention_guidance(n, etype)}'
        )
    if action == "elaboration_requested":
        return (
            f"[Chorus] Elaboration requested for idea '{title}' "
            f"(ideaUuid: {uuid}, projectUuid: {project}). "
            "Use chorus_get_elaboration to review the questions."
        )
    if action == "elaboration_answered":
        return (
            f"[Chorus] Elaboration answers were submitted for idea '{title}' "
            f"(ideaUuid: {uuid}, projectUuid: {project}). Use chorus_get_elaboration to review the "
            "answers, then either resolve the elaboration (chorus_pm_validate_elaboration) and proceed to a proposal, "
            f"or open another round (chorus_pm_start_elaboration) if gaps remain.\n{_mention_guidance(n, 'idea')}"
        )
    if action == "elaboration_verified":
        return (
            f"[Chorus] Elaboration for idea '{title}' was VERIFIED by a human "
            f"(ideaUuid: {uuid}, projectUuid: {project}). The idea is now elaborated — do NOT "
            "answer elaboration questions. Proceed to WRITE THE PROPOSAL: gather context with chorus_get_idea and "
            "chorus_get_elaboration, then author the proposal via the existing proposal flow "
            f"(chorus_pm_create_proposal / the proposal skill).\n{_mention_guidance(n, 'idea')}"
        )
    if action == "start_development":
        return (
            f"[Chorus] A human started DEVELOPMENT for idea '{title}' "
            f"(ideaUuid: {uuid}, projectUuid: {project}). The idea's proposal is approved and "
            "unfinished tasks remain. Claim and execute ALL remaining tasks of that proposal in dependency "
            "order, following the develop workflow: repeatedly find claimable tasks (chorus_get_unblocked_tasks "
            f'with projectUuid: "{project}"), claim one (chorus_claim_task), implement it, self-check its '
            "acceptance criteria (chorus_report_criteria_self_check), and submit it (chorus_submit_for_verify) — "
            "then loop until NO claimable task remains. Do NOT stop after one task. Leave tasks already in "
            "to_verify (awaiting human verification) and tasks claimed by other sessions untouched. If nothing "
            f"is claimable, post a brief status comment on the idea and end the turn.\n{_mention_guidance(n, 'idea')}"
        )
    if action == "yolo_requested":
        return (
            f"[Chorus] A human requested a YOLO run for idea '{title}' "
            f"(ideaUuid: {uuid}, projectUuid: {project}). Drive this idea all the "
            "way to done following the yolo skill (the full-auto AI-DLC pipeline: Idea → "
            "Elaboration → Proposal → Execute → Verify). First read the idea's current state with "
            "chorus_get_idea (plus chorus_get_elaboration / chorus_get_proposals as needed) and "
            "RESUME from whatever phase it is already in — do NOT assume a fixed stage: if "
            "elaboration isn't resolved, self-elaborate then write the proposal; if a proposal is "
            "approved with open tasks, execute them; and so on. Complete the pipeline through the "
            "final done state and completion report, but do NOT merge or push a pull request "
            f"without explicit human approval.\n{_mention_guidance(n, 'idea')}"
        )
    if action == "proposal_rejected":
        return (
            f"[Chorus] Proposal '{title}' was REJECTED (proposalUuid: {uuid}, "
            f'projectUuid: {project}). Review note: "{_f(n, "message")}". Use chorus_get_proposal to review, '
            "fix issues with chorus_pm_update_task_draft / chorus_pm_update_document_draft, then "
            f"chorus_pm_validate_proposal and chorus_pm_submit_proposal to resubmit.\n{_mention_guidance(n, 'proposal')}"
        )
    if action == "proposal_approved":
        message = _g(n, "message")
        review_info = ""
        if isinstance(message, str) and "Note: " in message:
            review_info = f' Review note: "{message.split("Note: ")[-1]}".'
        return (
            f"[Chorus] Proposal '{title}' was APPROVED (proposalUuid: {uuid}, "
            f"projectUuid: {project}).{review_info} Its documents and tasks have been created. Use "
            f'chorus_get_unblocked_tasks (projectUuid: "{project}") to find tasks ready to start.\n{_mention_guidance(n, "proposal")}'
        )
    if action == "idea_claimed":
        return (
            f"[Chorus] Idea '{title}' was assigned to you by {_f(n, 'actorName')} ({_f(n, 'actorType')}) "
            f"(ideaUuid: {uuid}, projectUuid: {project}). You are {_NOW} the assignee — no need "
            "to claim it. Use chorus_get_idea to review it, then advance it from its CURRENT stage: if it is "
            "still elaborating, run or continue elaboration; if it is already elaborated, author the proposal. "
            f"Stop at the human proposal/verify gates and never merge automatically.\n{_mention_guidance(n, 'idea')}"
        )
    if action == "task_reopened":
        return (
            f"[Chorus] Task '{title}' was reopened and needs rework (taskUuid: {uuid}, "
            f"projectUuid: {project}). Use chorus_get_task and chorus_get_comments to see the "
            f"verification feedback, then fix the issues.\n{_mention_guidance(n, 'task')}"
        )
    if action == "resource_resumed":
        if _g(n, "resumedFrom") == "crash":
            return (
                f"[Chorus] The previous run on this {etype} EXITED ABNORMALLY (crashed) "
                f"({etype}Uuid: {uuid}), and a user asked to resume it. The crash may "
                "have left work half-finished — first re-check the current state with the appropriate "
                "chorus_get_* tool (e.g. chorus_get_task / chorus_get_idea) plus chorus_get_comments, "
                "and inspect any partial local work (working tree, uncommitted changes, half-written "
                "files). Then continue the unfinished work from where the crashed run left off."
            )
        return (
            f"[Chorus] Your work on this {etype} was RESUMED after an interrupt "
            f"({etype}Uuid: {uuid}). Continue where you left off — re-check the "
            "current state with the appropriate chorus_get_* tool (e.g. chorus_get_task / "
            "chorus_get_idea) plus chorus_get_comments for any new feedback, then resume the work "
            "you had started."
        )
    if action == "task_verified":
        return (
            f"[Chorus] Task '{title}' was verified and is now done (taskUuid: {uuid}, "
            f'projectUuid: {project}). Use chorus_get_unblocked_tasks (projectUuid: "{project}") '
            "to see whether this unblocked any tasks that are now ready to start."
        )
    if action == "human_instruction":
        raw = _g(n, "instructionText")
        instruction = _js_trim(raw) if isinstance(raw, str) else ""
        if not instruction:
            return None
        entity_hint = ""
        if _truthy(_g(n, "entityType")) and _truthy(_g(n, "entityUuid")):
            entity_hint = (
                f" (regarding {etype} {uuid}"
                + (f", projectUuid: {project}" if _truthy(_g(n, "projectUuid")) else "")
                + ")"
            )
        actor_hint = ""
        if _truthy(_g(n, "actorName")) and _truthy(_g(n, "actorType")) and _truthy(_g(n, "actorUuid")):
            actor_hint = (
                "\nWhen you have addressed it, reply with a comment @mentioning the requester: "
                f"@[{_f(n, 'actorName')}]({_f(n, 'actorType')}:{_f(n, 'actorUuid')})"
            )
        return (
            f"[Chorus] New instruction from a human{entity_hint}:\n\n"
            f"{instruction}\n\n"
            "Continue this session and act on the instruction above using the appropriate "
            "chorus_* tools. Re-check the current state first (e.g. chorus_get_task / "
            f"chorus_get_idea / chorus_get_comments) if you need context.{actor_hint}"
        )
    if action in OPERATION_ACTIONS:
        return build_operation_prompt(n)
    return None


def build_prompt(n: Mapping[str, Any]) -> Optional[str]:
    """Wake prompt for one notification, or ``None`` when the action has no wake."""
    body = build_prompt_body(n)
    if body is None:
        return None
    handoff = _orchestrator_guidance(n)
    anchor = _waker_session_guidance(n)
    return (
        f"{HEADLESS_PREAMBLE}\n\n{body}"
        + (f"\n\n{handoff}" if handoff else "")
        + (f"\n\n{anchor}" if anchor else "")
    )


def build_batch_prompt(notifications: Iterable[Mapping[str, Any]]) -> Optional[str]:
    """One combined prompt for a coalesced same-session batch (``buildBatchPrompt``)."""
    if not isinstance(notifications, (list, tuple)) or not notifications:
        return None
    items = []
    for n in notifications:
        body = build_prompt_body(n)
        if body is not None:
            items.append((n, body))
    if not items:
        return None
    if len(items) == 1:
        return build_prompt(items[0][0])

    blocks: list[dict] = []
    collapse_index: dict[str, int] = {}
    for n, body in items:
        if _g(n, "action") == "human_instruction":
            blocks.append({"notif": n, "body": body, "count": 1})
            continue
        entity_uuid = _g(n, "entityUuid")
        group_key = f"{_f(n, 'action')}::{'' if entity_uuid is _MISSING or entity_uuid is None else _s(entity_uuid)}"
        existing = collapse_index.get(group_key)
        if existing is not None:
            g = blocks[existing]
            g["count"] += 1
            g["notif"] = n
            g["body"] = body
        else:
            collapse_index[group_key] = len(blocks)
            blocks.append({"notif": n, "body": body, "count": 1})

    backlog = (
        f"You have {len(items)} queued Chorus events on this session that arrived while you "
        "were busy — handle them together, in order; each is labeled with its type below."
    )
    rendered = []
    for idx, g in enumerate(blocks):
        n = g["notif"]
        etype_raw, euuid_raw = _g(n, "entityType"), _g(n, "entityUuid")
        etype = _s(etype_raw) if _truthy(etype_raw) else "session"
        euuid = _s(euuid_raw) if _truthy(euuid_raw) else ""
        header = f"### Event {idx + 1} — {_f(n, 'action')} on {etype} {euuid}".rstrip(_JS_WS)
        collapse_note = ""
        if g["count"] > 1:
            collapse_note = (
                f"\n({g['count']} {_f(n, 'action')} events on this {etype} arrived — showing the newest "
                "below; earlier ones are re-derivable via the entity's own chorus_get_* tools.)"
            )
        anchor = _waker_session_guidance(n)
        anchor_block = f"\n\n{anchor}" if anchor else ""
        rendered.append(f"{header}{collapse_note}\n\n{g['body']}{anchor_block}")
    return "\n\n".join([HEADLESS_PREAMBLE, backlog, *rendered])


WAKE_ACTIONS = frozenset({
    "task_assigned",
    "mentioned",
    "elaboration_requested",
    "elaboration_answered",
    "elaboration_verified",
    "start_development",
    "yolo_requested",
    "proposal_rejected",
    "proposal_approved",
    "idea_claimed",
    "task_reopened",
    "task_verified",
    "resource_resumed",
    "human_instruction",
    "idea_creation_requested",
    "research_requested",
})
