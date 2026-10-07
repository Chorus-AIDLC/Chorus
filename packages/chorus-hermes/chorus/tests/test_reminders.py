import subprocess

import pytest

from chorus_hermes import reminders as r

P, T, PRJ, IDEA = "prop-1", "task-1", "proj-1", "idea-1"


class FakeChorus:
    def __init__(self, *, tasks=None, total=None, desc="OpenSpec change slug: my-change", input_type="idea",
                 input_uuids=(IDEA,), docs=(), fail=()):
        self.tasks = [{"uuid": f"t{i}", "status": s} for i, s in enumerate(["done", "done"] if tasks is None else tasks)]
        self.total = len(self.tasks) if total is None else total
        self.proposal = {"uuid": P, "description": desc, "inputType": input_type, "inputUuids": list(input_uuids)}
        self.docs = list(docs)
        self.fail = set(fail)
        self.calls = []

    def __call__(self, name, args):
        self.calls.append((name, dict(args)))
        if name in self.fail:
            raise RuntimeError(name)
        if name == "chorus_get_task":
            return {"uuid": args["taskUuid"], "proposalUuid": P, "project": {"uuid": PRJ}}
        if name == "chorus_get_proposal":
            return self.proposal
        if name == "chorus_list_tasks":
            assert args["pageSize"] <= 100
            return {"tasks": self.tasks, "total": self.total}
        if name == "chorus_get_documents":
            return {"documents": self.docs, "total": len(self.docs)}
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
    assert [n for n, _ in chorus.calls].count("chorus_list_tasks") == 1
