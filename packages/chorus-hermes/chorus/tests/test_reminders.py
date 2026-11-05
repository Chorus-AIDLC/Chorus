import subprocess

import pytest

from chorus_hermes import reminders as r

P, T, PRJ, IDEA = "prop-1", "task-1", "proj-1", "idea-1"


class FakeChorus:
    def __init__(self, *, tasks=None, total=None, desc="OpenSpec change slug: my-change", input_type="idea",
                 input_uuids=(IDEA,), docs=(), fail=(), linked=(), linked_total=None,
                 task_proposal=P, task_idea=None, idea=None):
        self.tasks = [{"uuid": f"t{i}", "status": s} for i, s in enumerate(["done", "done"] if tasks is None else tasks)]
        self.total = len(self.tasks) if total is None else total
        # Quick Tasks linked directly to the idea (chorus_list_tasks ideaUuid filter).
        self.linked = [{"uuid": f"q{i}", "status": s} for i, s in enumerate(linked)]
        self.linked_total = len(self.linked) if linked_total is None else linked_total
        self.task_proposal, self.task_idea = task_proposal, task_idea
        self.proposal = {"uuid": P, "description": desc, "inputType": input_type, "inputUuids": list(input_uuids)}
        self.docs = list(docs)
        self.fail = set(fail)
        # chorus_get_idea payload; None = older server without the tool result
        # this test cares about (falls through to AssertionError -> legacy path).
        self.idea = idea
        self.calls = []

    def __call__(self, name, args):
        self.calls.append((name, dict(args)))
        if name in self.fail:
            raise RuntimeError(name)
        if name == "chorus_get_task":
            return {"uuid": args["taskUuid"], "proposalUuid": self.task_proposal, "ideaUuid": self.task_idea,
                    "project": {"uuid": PRJ}}
        if name == "chorus_get_proposal":
            return self.proposal
        if name == "chorus_list_tasks":
            assert args["pageSize"] <= 100
            if "ideaUuid" in args:
                return {"tasks": self.linked, "total": self.linked_total}
            return {"tasks": self.tasks, "total": self.total}
        if name == "chorus_get_documents":
            return {"documents": self.docs, "total": len(self.docs)}
        if name == "chorus_get_idea" and self.idea is not None:
            return {"uuid": args["ideaUuid"], **self.idea}
        raise AssertionError(name)


@pytest.fixture
def repo(tmp_path):
    (tmp_path / "openspec").mkdir()
    return tmp_path


def ok_run(*_a, **_k):
    return subprocess.CompletedProcess([], 0)


def run_verify(chorus, root, env=None, which=lambda n: "/bin/openspec", run=ok_run):
    return r.verify_task_reminders(T, chorus, project_root=str(root), env=env or {}, which=which, run=run)


A, C, B = "[Chorus — OpenSpec Archive Trigger]", "[Chorus — Code-Review Gateway Trigger]", \
    "[Chorus — Idea-Completion Report Trigger]"


@pytest.mark.parametrize("name,op", [
    ("mcp__chorus__chorus_pm_submit_proposal", r.PROPOSAL_OP),
    ("chorus_submit_for_verify", r.SUBMIT_VERIFY_OP),
    ("anything__chorus_admin_verify_task", r.VERIFY_OP),
    ("mcp__chorus__chorus_admin_verify_task_v2", None),
    ("mcp__chorus__chorus_get_task", None),
    ("", None), (None, None),
])
def test_match_operation(name, op):
    assert r.match_operation(name) == op


def test_proposal_reminder_uses_delegate_task_and_marker():
    text = r.proposal_submitted(P)
    assert text.startswith("[Chorus — Proposal Submitted for Review]\nProposal prop-1 has been submitted.")
    assert "delegate_task(" in text and "spawn_agent" not in text
    assert 'goal="[chorus-reviewer:proposal] Review Chorus proposal prop-1' in text
    assert 'context="[chorus-reviewer:proposal]\\nFirst call skill_view(\\"chorus:chorus-proposal-reviewer\\")' in text
    assert "VERDICT: FAIL" in text and "chorus_pm_reject_proposal" in text and "chorus_admin_approve_proposal" in text


def test_task_reminder_evidence_bundle():
    text = r.task_submitted(None)
    assert "Task <uuid> has been submitted" in text
    assert 'context="[chorus-reviewer:task]\\n' in text and "chorus:chorus-task-reviewer" in text
    assert "evidence bundle" in text and "test command output" in text
    assert "chorus_admin_reopen_task" in text and "chorus_admin_verify_task" in text


def test_all_branches_fire_in_order(repo):
    out = run_verify(FakeChorus(), repo)
    assert out.index(A) < out.index(C) < out.index(B)
    assert "`openspec archive my-change`" in out and PRJ in out
    assert "spawn code-reviewer" in out and "[chorus-reviewer:code]" in out and IDEA in out
    assert "chorus:chorus-code-reviewer" in out
    assert "create idea-completion report" in out and 'proposalUuid="prop-1"' in out


# --- Branch A gates ------------------------------------------------------------

def test_a_skipped_when_openspec_mode_off(repo):
    out = run_verify(FakeChorus(), repo, env={"CHORUS_OPENSPEC_MODE": "off"})
    assert A not in out and C in out


def test_a_skipped_without_dir(tmp_path):
    assert A not in run_verify(FakeChorus(), tmp_path)


def test_a_skipped_without_cli_or_failing_version(repo):
    assert A not in run_verify(FakeChorus(), repo, which=lambda n: None)
    assert A not in run_verify(FakeChorus(), repo, run=lambda *a, **k: subprocess.CompletedProcess([], 1))

    def boom(*a, **k):
        raise OSError("nope")
    assert A not in run_verify(FakeChorus(), repo, run=boom)


def test_a_skipped_without_slug_line(repo):
    out = run_verify(FakeChorus(desc="free-form\nslug: x"), repo)
    assert A not in out and C in out


def test_a_slug_on_later_line(repo):
    out = run_verify(FakeChorus(desc="intro\nOpenSpec change slug:   spaced-slug  \nmore"), repo)
    assert "`openspec archive spaced-slug`" in out


def test_a_requires_done_not_closed(repo):
    out = run_verify(FakeChorus(tasks=["done", "closed"]), repo)
    assert A not in out and C in out and B in out


def test_a_c_skipped_for_zero_tasks_but_b_fires(repo):
    out = run_verify(FakeChorus(tasks=[]), repo)
    assert A not in out and C not in out and B in out


def test_pagination_guard_skips_all(repo):
    assert run_verify(FakeChorus(total=500), repo) == ""


def test_open_task_skips_all(repo):
    assert run_verify(FakeChorus(tasks=["done", "in_progress"]), repo) == ""


# --- Branch C gates ------------------------------------------------------------

def test_c_toggle_off(repo):
    out = run_verify(FakeChorus(), repo, env={"CHORUS_ENABLE_CODE_REVIEWER": "false"})
    assert C not in out and A in out and B in out


def test_c_requires_idea_uuid(repo):
    out = run_verify(FakeChorus(input_uuids=()), repo)
    assert C not in out and B in out


def test_document_rooted_proposal_only_archive(repo):
    out = run_verify(FakeChorus(input_type="document"), repo)
    assert out.startswith(A) and C not in out and B not in out


# --- Branch B gates ------------------------------------------------------------

def test_b_skipped_when_report_exists(repo):
    out = run_verify(FakeChorus(docs=[{"uuid": "d1", "proposalUuid": P}]), repo)
    assert B not in out and C in out


def test_b_ignores_other_proposals_reports(tmp_path):
    out = run_verify(FakeChorus(docs=[{"uuid": "d1", "proposalUuid": "other"}]), tmp_path)
    assert B in out


def test_b_skipped_when_documents_fail(tmp_path):
    out = run_verify(FakeChorus(fail={"chorus_get_documents"}), tmp_path)
    assert B not in out and C in out


# --- errors --------------------------------------------------------------------

@pytest.mark.parametrize("failing", ["chorus_get_task", "chorus_get_proposal"])
def test_shared_lookup_failure_returns_empty(repo, failing):
    assert run_verify(FakeChorus(fail={failing}), repo) == ""


def test_list_tasks_failure_returns_empty(repo):
    assert run_verify(FakeChorus(fail={"chorus_list_tasks"}), repo) == ""


def test_quick_task_without_proposal(repo):
    def call(name, args):
        return {"uuid": T, "proposalUuid": None, "project": {"uuid": PRJ}}
    assert run_verify(call, repo) == ""
    assert r.verify_task_reminders(None, call) == ""


def test_list_tasks_fetched_once(repo):
    chorus = FakeChorus()
    run_verify(chorus, repo)
    proposal_lists = [a for n, a in chorus.calls if n == "chorus_list_tasks" and "proposalUuids" in a]
    assert len(proposal_lists) == 1


# --- Quick Tasks linked to an idea (Task.ideaUuid) -------------------------------

LINKED_IDEA = "idea-L"


def quick(**kw):
    return FakeChorus(task_proposal=None, task_idea=LINKED_IDEA, **kw)


def test_linked_quick_task_fires_only_code_review(repo):
    chorus = quick(linked=["done", "closed"])
    out = run_verify(chorus, repo)
    assert C in out and A not in out and B not in out
    assert f"idea {LINKED_IDEA}" in out and f'ideaUuid="{LINKED_IDEA}"' in out
    assert "no idea-completion report applies" in out
    names = [n for n, _ in chorus.calls]
    assert "chorus_get_proposal" not in names and "chorus_get_documents" not in names
    assert ("chorus_list_tasks", {"projectUuid": PRJ, "ideaUuid": LINKED_IDEA, "pageSize": 100}) in chorus.calls


@pytest.mark.parametrize("kw", [
    {"linked": ["done", "in_progress"]},
    {"linked": ["done"], "linked_total": 120},
    {"linked": []},
])
def test_linked_quick_task_waits(repo, kw):
    assert run_verify(quick(**kw), repo) == ""


def test_linked_quick_task_toggle_off(repo):
    assert run_verify(quick(linked=["done"]), repo, env={"CHORUS_ENABLE_CODE_REVIEWER": "false"}) == ""


def test_linked_quick_task_list_failure(repo):
    assert run_verify(quick(linked=["done"], fail={"chorus_list_tasks"}), repo) == ""


def test_unlinked_quick_task_silent(repo):
    chorus = FakeChorus(task_proposal=None, task_idea=None, linked=["done"])
    assert run_verify(chorus, repo) == ""
    assert [n for n, _ in chorus.calls] == ["chorus_get_task"]


def test_proposal_gateway_waits_for_linked_quick_tasks(repo):
    out = run_verify(FakeChorus(linked=["done", "open"]), repo)
    assert C not in out and A in out and B in out  # A and B stay proposal-scoped


def test_proposal_gateway_fires_when_linked_quick_tasks_done(repo):
    chorus = FakeChorus(linked=["done", "closed"])
    out = run_verify(chorus, repo)
    assert C in out and "and any Quick Tasks linked to the idea" in out
    assert ("chorus_list_tasks", {"projectUuid": PRJ, "ideaUuid": IDEA, "pageSize": 100}) in chorus.calls


# --- Server-derived idea status gates the code-review gateway (CR-R3 B3) ---------


def _leo_repro_call(derived):
    """Leo's round-3 repro: linked Quick Task done, same idea's approved-proposal task in_progress."""
    calls = []

    def call(tool, args):
        calls.append((tool, args))
        if tool == "chorus_get_task":
            return {"uuid": "quick-1", "proposalUuid": None, "ideaUuid": "idea-1", "project": {"uuid": "project-1"}}
        if tool == "chorus_get_idea":
            if derived is None:
                return {"uuid": "idea-1"}  # older server: no derivedStatus field
            return {"uuid": "idea-1", "derivedStatus": derived}
        if tool == "chorus_get_proposals":
            return {"proposals": [{"uuid": "proposal-1", "status": "approved", "inputType": "idea",
                                   "inputUuids": ["idea-1"]}], "total": 1}
        if tool == "chorus_list_tasks":
            tasks = [{"uuid": "quick-1", "status": "done"}] if args.get("ideaUuid") else \
                [{"uuid": "proposal-task-1", "status": "in_progress"}]
            return {"tasks": tasks, "total": len(tasks)}
        raise AssertionError(tool)

    return call, calls


def test_mixed_idea_quick_task_first_is_silent():
    # Server union says the idea is still building -> no final gateway.
    call, calls = _leo_repro_call("in_progress")
    out = r.verify_task_reminders("quick-1", call, env={"CHORUS_OPENSPEC_MODE": "off"})
    assert out == ""
    assert ("chorus_get_idea", {"ideaUuid": "idea-1"}) in calls
    # The server answer is authoritative: no client-side task counting.
    assert not any(n == "chorus_list_tasks" for n, _ in calls)


def test_mixed_idea_quick_task_first_legacy_server_keeps_old_behaviour():
    # derivedStatus absent (older server) -> previous task-count logic applies.
    call, calls = _leo_repro_call(None)
    out = r.verify_task_reminders("quick-1", call, env={"CHORUS_OPENSPEC_MODE": "off"})
    assert C in out
    assert ("chorus_list_tasks", {"projectUuid": "project-1", "ideaUuid": "idea-1", "pageSize": 100}) in calls


def test_mixed_idea_proposal_task_first_is_silent(repo):
    # Proposal tasks all done, linked Quick Task still in_progress -> server says building.
    out = run_verify(FakeChorus(linked=["in_progress"], idea={"derivedStatus": "in_progress"}), repo)
    assert C not in out and A in out and B in out  # A and B stay proposal-scoped


@pytest.mark.parametrize("derived", ["human_conduct_required", "todo", "in_progress"])
def test_proposal_task_silent_unless_derived_done(repo, derived):
    # Even when every client-visible list is terminal, the server status wins.
    out = run_verify(FakeChorus(linked=["done"], idea={"derivedStatus": derived}), repo)
    assert C not in out


def test_mixed_idea_both_done_fires_from_quick_task(repo):
    chorus = quick(linked=["done"], idea={"derivedStatus": "done"})
    out = run_verify(chorus, repo)
    assert C in out and A not in out and B not in out
    assert f"gateway for idea {LINKED_IDEA}" in out
    assert "any approved-proposal tasks" in out
    assert ("chorus_get_idea", {"ideaUuid": LINKED_IDEA}) in chorus.calls


def test_mixed_idea_both_done_fires_from_proposal_task(repo):
    chorus = FakeChorus(linked=["done"], idea={"derivedStatus": "done"})
    out = run_verify(chorus, repo)
    assert C in out and "and any Quick Tasks linked to the idea" in out
    assert ("chorus_get_idea", {"ideaUuid": IDEA}) in chorus.calls
    # Branch C no longer needs the linked-task list when the server answered.
    assert not any(n == "chorus_list_tasks" and "ideaUuid" in a for n, a in chorus.calls)


def test_proposal_task_legacy_server_without_field(repo):
    # chorus_get_idea answers but without derivedStatus -> legacy linked-task check.
    assert C not in run_verify(FakeChorus(linked=["open"], idea={}), repo)
    assert C in run_verify(FakeChorus(linked=["done"], idea={}), repo)


def test_get_idea_failure_falls_back_to_legacy(repo):
    assert C in run_verify(quick(linked=["done"], fail={"chorus_get_idea"}), repo)
    assert C not in run_verify(quick(linked=["in_progress"], fail={"chorus_get_idea"}), repo)
