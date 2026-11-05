"""Post-tool reminder text and the ``chorus_admin_verify_task`` branch logic.

Ported from the Codex hooks in ``plugins/chorus/hooks/``:

- ``on-post-submit-proposal.sh``  -> :func:`proposal_submitted`
- ``on-post-submit-for-verify.sh`` -> :func:`task_submitted`
- ``on-post-verify-task.sh``       -> :func:`verify_task_reminders` (branches A, C, B)

Hermes differences: sub-agents are spawned with ``delegate_task(goal, context)``
instead of Codex ``spawn_agent``; the reviewer ``context`` (and ``goal``) start
with the ``[chorus-reviewer:<kind>]`` marker that the read-only reviewer guard
(``skills.py``) keys on; the child loads its workflow with
``skill_view("chorus:chorus-<kind>-reviewer")``. The guard blocks ``terminal``
inside reviewers, so the parent prepares an evidence bundle first.

This module never raises on bad data from Chorus: every gate that cannot be
evaluated is a silent skip, exactly like the shell hooks.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
from typing import Any, Callable, Mapping, Optional

PROPOSAL_OP = "chorus_pm_submit_proposal"
SUBMIT_VERIFY_OP = "chorus_submit_for_verify"
VERIFY_OP = "chorus_admin_verify_task"
OPERATIONS = (PROPOSAL_OP, SUBMIT_VERIFY_OP, VERIFY_OP)

ENV_OPENSPEC_MODE = "CHORUS_OPENSPEC_MODE"
# Hermes equivalent of CLAUDE_PLUGIN_OPTION_ENABLECODEREVIEWER (default true).
ENV_ENABLE_CODE_REVIEWER = "CHORUS_ENABLE_CODE_REVIEWER"

# Chorus list tools cap pageSize at 100; the total>returned guard below makes a
# wider proposal skip silently instead of evaluating a partial page.
PAGE_SIZE = 100

_SLUG_RE = re.compile(r"^OpenSpec change slug: (.+)$", re.MULTILINE)

CallTool = Callable[[str, Mapping[str, Any]], Any]


def match_operation(tool_name: Any) -> Optional[str]:
    """Any prefix, but the identifier must END with the full operation name (Pi/dsh rule)."""
    if not isinstance(tool_name, str) or not tool_name:
        return None
    for op in OPERATIONS:
        if tool_name.endswith(op):
            return op
    return None


def reviewer_marker(kind: str) -> str:
    return f"[chorus-reviewer:{kind}]"


_EVIDENCE = (
    "The reviewer is read-only: it cannot run `terminal` (no tests, no `git diff`). Before delegating, "
    "prepare the evidence bundle yourself — write `git diff` / `git log` of the change{tests} to files "
    "(e.g. under /tmp/chorus-review/{uuid}/) and pass the file paths in `context` "
    "(\"Evidence: /tmp/chorus-review/{uuid}/diff.patch, tests.txt\"); the reviewer reads them with read_file."
)


def _delegate_block(kind: str, uuid: str, goal: str, child_text: str) -> str:
    marker = reviewer_marker(kind)
    return (
        "How to spawn (delegate_task blocks until the child returns its summary):\n"
        "  delegate_task(\n"
        f"    goal=\"{marker} {goal}\",\n"
        f"    context=\"{marker}\\n"
        f"First call skill_view(\\\"chorus:chorus-{kind}-reviewer\\\") and follow it. {child_text}\\n"
        "Evidence: <paths of the evidence files>\"\n"
        "  )\n"
        f"Keep `{marker}` on the first line of `context` (and in `goal`): the plugin uses it to run the child "
        "under the read-only reviewer guard."
    )


def proposal_submitted(proposal_uuid: Optional[str]) -> str:
    uuid = proposal_uuid or "<uuid>"
    return (
        "[Chorus — Proposal Submitted for Review]\n"
        f"Proposal {uuid} has been submitted.\n\n"
        "ACTION REQUIRED: Spawn the `chorus-proposal-reviewer` sub-agent to perform an independent quality "
        "review before admin approval.\n\n"
        + _delegate_block(
            "proposal", uuid,
            f"Review Chorus proposal {uuid} and post one VERDICT comment",
            f"Review proposal {uuid}. Max review rounds: 3. First read existing comments to determine the "
            "round number; post VERDICT as a comment.")
        + "\n\nThis gate depends on the verdict, so wait for the child. Use a fresh context: put everything the "
        "reviewer needs (entity UUIDs, evidence paths) in `context`.\n\n"
        "The reviewer is read-only and posts its VERDICT as a comment on the proposal. Read comments after it "
        "returns and find THIS round's `VERDICT:` line — the comment posted after you dispatched the reviewer, "
        "not an older round's:\n"
        "- **VERDICT: PASS** — No issues. Proceed to `chorus_admin_approve_proposal`.\n"
        "- **VERDICT: PASS WITH NOTES** — Minor notes. Still approve.\n"
        "- **VERDICT: FAIL** — BLOCKERs found. Do NOT approve. Reject with `chorus_pm_reject_proposal`, fix, "
        "resubmit."
    )


def task_submitted(task_uuid: Optional[str]) -> str:
    uuid = task_uuid or "<uuid>"
    return (
        "[Chorus — Task Submitted for Verification]\n"
        f"Task {uuid} has been submitted for verification.\n\n"
        "ACTION REQUIRED: Spawn the `chorus-task-reviewer` sub-agent to verify implementation against AC "
        "before admin verification.\n\n"
        + _EVIDENCE.format(tests=" and the project test command output", uuid=uuid)
        + "\n\n"
        + _delegate_block(
            "task", uuid,
            f"Review Chorus task {uuid} and post one VERDICT comment",
            f"Review Chorus task {uuid}. Max review rounds: 3. Post VERDICT as a comment.")
        + "\n\nThis gate depends on the verdict, so wait for the child. Use a fresh context: put everything the "
        "reviewer needs (entity UUIDs, evidence paths) in `context`.\n\n"
        "The reviewer is read-only and posts its VERDICT as a comment. After it returns, read THIS round's "
        "`VERDICT:` comment on the task — the one posted after you dispatched the reviewer, not an older "
        "round's. Do not verify or reopen before you have read it:\n"
        "- **VERDICT: PASS / PASS WITH NOTES** — Mark AC and call `chorus_admin_verify_task`.\n"
        "- **VERDICT: FAIL** — Do NOT verify. Call `chorus_admin_reopen_task`, fix BLOCKERs, resubmit."
    )


def openspec_archive(proposal_uuid: str, slug: str, project_uuid: str) -> str:
    return (
        "[Chorus — OpenSpec Archive Trigger]\n"
        f"The last task of OpenSpec-mode proposal {proposal_uuid} (slug `{slug}`) has been admin-verified.\n\n"
        "ACTION REQUIRED: archive the OpenSpec change locally and mirror updated specs back to the Chorus "
        "Documents. Run the steps below in order; HALT immediately on any error (no silent errors).\n\n"
        f"1. Run `openspec archive {slug}` in the repo root. This moves `openspec/changes/{slug}/` under "
        f"`openspec/changes/archive/<date>-{slug}/` and emits/updates one `openspec/specs/<capability>/spec.md` "
        "per capability. If the CLI prompts interactively and a `--yes`/`--no-confirm` flag is available, use it "
        "(verify with `openspec archive --help`).\n\n"
        "2. For EACH newly-emitted `openspec/specs/<capability>/spec.md`:\n"
        f"   - List all spec-type Documents in this project: `chorus_get_documents({{projectUuid: \"{project_uuid}\", "
        "type: \"spec\"})`. The `type` filter is the only server-side filter — do client-side title matching "
        "against the documents you get back.\n"
        "   - Find the Document whose title matches the capability (typical title shape `Spec: <capability>`).\n"
        "   - Call `chorus_pm_update_document` with the new content from the on-disk spec.md — fill `content` "
        "from the file (`chorus mcp call chorus_pm_update_document '<json>' --arg-file content=<file>`), never "
        "hand-typed.\n\n"
        "3. On any error from `openspec archive` or `chorus_pm_update_document`: print stderr verbatim, post a "
        "comment on the proposal recording the failure (`chorus_add_comment({targetType: \"proposal\", "
        f"targetUuid: \"{proposal_uuid}\", content: \"...\"}})`), and HALT. No retry, no silent skip.\n\n"
        "4. Confirm each updated spec round-trips byte-exactly: fetch it with `chorus mcp call chorus_get_document` "
        "and compare against the local file with an exact-byte check (e.g. `cmp` or SHA-256 of both); report only "
        "byte counts and hashes on mismatch. Do not normalize newlines.\n\n"
        "References: openspec-aware skill (`skill_view(\"chorus:openspec-aware\")`) — mirror-back contract and "
        "this archive trigger."
    )


def code_review(proposal_uuid: Optional[str], idea_uuid: str) -> str:
    """Gateway reminder; ``proposal_uuid=None`` means a linked Quick Task (no proposal) closed the idea."""
    marker = reviewer_marker("code")
    if proposal_uuid:
        headline = (f"All tasks of idea-rooted proposal {proposal_uuid} (and any Quick Tasks linked to the idea) "
                    "are now done.")
        fix_target = "create Proposal-linked fix tasks"
        report_line = "Run the code-review gateway BEFORE writing any idea-completion report."
    else:
        headline = (f"Every task of idea {idea_uuid} is now done — its linked Quick Tasks and any "
                    "approved-proposal tasks.")
        fix_target = f"create fix Quick Tasks linked to the idea (chorus_create_tasks with ideaUuid=\"{idea_uuid}\")"
        report_line = ("A linked Quick Task closed this idea, so no completion-report reminder follows here. If the "
                       "idea has no proposal, no idea-completion report applies and the VERDICT comment on the idea "
                       "is the ship record; if it also has an approved proposal, write that proposal's "
                       "idea-completion report only after this gateway passes.")
    return (
        "[Chorus — Code-Review Gateway Trigger]\n"
        f"{headline} This is the final ship-time gateway for idea {idea_uuid}.\n\n"
        "ACTION REQUESTED: spawn code-reviewer for this idea — an independent, read-only review of the idea's "
        "AGGREGATE code change (the whole feature across all its tasks), not a single task. "
        + _EVIDENCE.format(tests=" across all of the idea's tasks and the project test command output",
                           uuid=idea_uuid)
        + f" Then call delegate_task(goal=\"{marker} Review aggregate code for idea {idea_uuid} and post one "
        f"VERDICT comment\", context=\"{marker}\\nFirst call skill_view(\\\"chorus:chorus-code-reviewer\\\") and "
        f"follow it. Review aggregate code for idea {idea_uuid}. Round: <N>. Post VERDICT.\\nEvidence: <paths>\"), "
        "keeping the marker on the first line of `context`; the round number comes from prior code-review "
        "verdict comments on the idea. It reviews cross-task integration, architecture/convention consistency, "
        "security, regression/performance, feature-level test coverage, and overall code soundness, then posts "
        "ONE VERDICT comment on the idea. Read THIS round's VERDICT on the idea (chorus_get_comments "
        "targetType=\"idea\") — the comment posted after your dispatch, not an earlier round's, and do not "
        "declare the feature shippable before you have read it: PASS / PASS WITH NOTES -> may ship; FAIL -> the "
        f"orchestrator must invoke Quick Dev to {fix_target} (group related small BLOCKERs; "
        "split only materially large or independently testable work; never reopen completed tasks or apply "
        "untracked fixes). Re-run only after every fix task passes AC self-check, independent task review, and "
        "admin verification to `done`; failed or cancelled fixes stop and escalate. Keep the maxCodeReviewRounds "
        f"cap. {report_line}"
    )


def completion_report(proposal_uuid: str) -> str:
    return (
        "[Chorus — Idea-Completion Report Trigger]\n"
        f"All tasks of proposal {proposal_uuid} are now done; no completion report yet.\n\n"
        "ACTION REQUESTED: create idea-completion report for this Idea. Call `chorus_create_report` with "
        f"proposalUuid=\"{proposal_uuid}\". The `content` parameter's description carries the Summary / "
        "Decisions / Follow-ups template."
    )


# --------------------------------------------------------------------------- verify-task branches


def _openspec_cli_ok(which: Callable[[str], Optional[str]],
                     run: Callable[..., Any]) -> bool:
    exe = which("openspec")
    if not exe:
        return False
    try:
        proc = run([exe, "--version"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
    except Exception:
        return False
    return getattr(proc, "returncode", 1) == 0


def _page(data: Any, key: str) -> Optional[list]:
    """Items of a paginated Chorus list, or ``None`` when unusable / truncated (total > returned)."""
    if not isinstance(data, Mapping):
        return None
    items = data.get(key) or []
    if not isinstance(items, list):
        return None
    try:
        total = int(data.get("total") or 0)
    except (TypeError, ValueError):
        return None
    if total > len(items):
        return None
    return items


def _statuses(tasks: list) -> list:
    return [t.get("status") if isinstance(t, Mapping) else None for t in tasks]


def verify_task_reminders(
    task_uuid: Optional[str],
    call: CallTool,
    *,
    project_root: Optional[str] = None,
    env: Optional[Mapping[str, str]] = None,
    which: Callable[[str], Optional[str]] = shutil.which,
    run: Callable[..., Any] = subprocess.run,
) -> str:
    """Combined post-verify reminder, ``[A archive][C code review][B report]``; ``""`` when none fires.

    ``call(name, args)`` returns the decoded Chorus tool result and may raise;
    any failure of a shared lookup skips every branch, a failure inside one
    branch skips only that branch (same as the shell hook).

    A Quick Task with no proposal but a linked ``ideaUuid`` runs only branch C;
    A and B stay proposal-only. Branch C resolves the idea (proposal
    ``inputUuids[0]`` or ``task.ideaUuid``) and fires only when the server's
    ``chorus_get_idea`` ``derivedStatus`` is ``"done"`` (union of
    approved-proposal and linked Quick Tasks), so a mixed idea never fires
    while either side is still building. When ``derivedStatus`` is absent
    (older server / idea read failed) it falls back to the client-side
    task-count check: proposal tasks plus linked Quick Tasks terminal.
    """
    env = os.environ if env is None else env
    root = project_root or os.getcwd()
    if not task_uuid:
        return ""
    try:
        task = call("chorus_get_task", {"taskUuid": task_uuid})
        proposal_uuid = task.get("proposalUuid") if isinstance(task, Mapping) else None
        project = task.get("project") if isinstance(task, Mapping) else None
        project_uuid = project.get("uuid") if isinstance(project, Mapping) else None
        task_idea_uuid = task.get("ideaUuid") if isinstance(task, Mapping) else None
        if not project_uuid or not (proposal_uuid or task_idea_uuid):
            return ""
        proposal: Mapping = {}
        if proposal_uuid:
            proposal = call("chorus_get_proposal", {"proposalUuid": proposal_uuid})
            if not isinstance(proposal, Mapping):
                return ""
    except Exception:
        return ""

    def linked_tasks(idea_uuid: str) -> Optional[list]:
        """Quick Tasks linked directly to the idea (Task.ideaUuid), or ``None`` when unusable / truncated."""
        try:
            return _page(call("chorus_list_tasks", {
                "projectUuid": project_uuid, "ideaUuid": idea_uuid, "pageSize": PAGE_SIZE,
            }), "tasks")
        except Exception:
            return None

    tasks_cache: dict = {}

    def tasks() -> Optional[list]:
        if "v" not in tasks_cache:
            try:
                tasks_cache["v"] = _page(call("chorus_list_tasks", {
                    "projectUuid": project_uuid, "proposalUuids": [proposal_uuid], "pageSize": PAGE_SIZE,
                }), "tasks")
            except Exception:
                tasks_cache["v"] = None
        return tasks_cache["v"]

    def branch_a() -> str:
        if not proposal_uuid:  # proposal-only
            return ""
        if env.get(ENV_OPENSPEC_MODE) == "off":
            return ""
        if not os.path.isdir(os.path.join(root, "openspec")):
            return ""
        if not _openspec_cli_ok(which, run):
            return ""
        desc = proposal.get("description") or ""
        m = _SLUG_RE.search(desc) if isinstance(desc, str) else None
        slug = m.group(1).strip() if m else ""
        if not slug:
            return ""
        items = tasks()
        if not items:  # unusable, truncated, or zero-task proposal
            return ""
        if any(s != "done" for s in _statuses(items)):
            return ""
        return openspec_archive(proposal_uuid, slug, project_uuid)

    def all_terminal(items: Optional[list]) -> bool:
        return items is not None and all(s in ("done", "closed") for s in _statuses(items))

    def idea_derived_status(idea_uuid: str) -> Optional[str]:
        """Server-computed ``derivedStatus`` of the idea, or ``None`` when absent (older server) / unreadable."""
        try:
            idea = call("chorus_get_idea", {"ideaUuid": idea_uuid})
        except Exception:
            return None
        status = idea.get("derivedStatus") if isinstance(idea, Mapping) else None
        return status if isinstance(status, str) and status else None

    def branch_c() -> str:
        if (env.get(ENV_ENABLE_CODE_REVIEWER) or "true") != "true":
            return ""
        if proposal_uuid:
            if proposal.get("inputType") != "idea":
                return ""
            inputs = proposal.get("inputUuids") or []
            idea_uuid = inputs[0] if isinstance(inputs, list) and inputs else None
        else:
            idea_uuid = task_idea_uuid
        if not idea_uuid:
            return ""
        derived = idea_derived_status(idea_uuid)
        if derived is not None:
            # Server is the single source of truth (tracker/dashboard parity).
            if derived != "done":
                return ""
        elif not proposal_uuid:
            # Legacy fallback, proposal-less Quick Task: every linked Quick Task
            # must be terminal (the verified task is in the list, so empty = stale).
            linked = linked_tasks(idea_uuid)
            if not linked or not all_terminal(linked):
                return ""
        else:
            # Legacy fallback, proposal task: this proposal's tasks terminal
            # (zero-task proposal -> skip) and linked Quick Tasks terminal (none is fine).
            items = tasks()
            if not items or not all_terminal(items):
                return ""
            if not all_terminal(linked_tasks(idea_uuid)):
                return ""
        return code_review(proposal_uuid or None, idea_uuid)

    def branch_b() -> str:
        if not proposal_uuid:  # proposal-only
            return ""
        if proposal.get("inputType") != "idea":
            return ""
        if not all_terminal(tasks()):
            return ""
        try:
            docs = _page(call("chorus_get_documents", {
                "projectUuid": project_uuid, "type": "report", "pageSize": PAGE_SIZE,
            }), "documents")
        except Exception:
            return ""
        if docs is None:
            return ""
        if any(isinstance(d, Mapping) and d.get("proposalUuid") == proposal_uuid for d in docs):
            return ""
        return completion_report(proposal_uuid)

    parts = []
    for branch in (branch_a, branch_c, branch_b):
        try:
            text = branch()
        except Exception:
            text = ""
        if text:
            parts.append(text)
    return "\n\n".join(parts)
