# Lightweight research verification

Task: `2edee409-b153-4034-ad74-68ee3069b050`

Scope: seven skill distributions and their routing/discovery contracts. Tracker
UI, dispatch, and authoritative server eligibility are separate tasks. The
research-only invocation contract is included here for those callers.

## Automated checks

Run from the repository root:

```sh
node --test plugins/chorus/tests/research-distribution.test.mjs
pnpm exec vitest run cli/__tests__/init-file-template.test.mjs
node packages/chorus-dsh/scripts/validate-package.mjs
node packages/chorus-pi/scripts/validate-package.mjs
bash packages/chorus-dsh/scripts/check-pack.sh
bash packages/chorus-pi/scripts/check-pack.sh
env -u CHORUS_AGENT_PROFILE pnpm --dir packages/chorus-dsh test
```

Run `bash test/all.sh` from `packages/chorus-pi`. Validate each new research
directory with the skill-creator `quick_validate.py` helper.

Recorded on 2026-09-26: all 13 distribution tests and 36 Kiro installer tests
passed. Distribution tests resolve every stage's research link on seven
surfaces, install actual Kiro template assets into a temporary directory with
local fixture transport, resolve standalone static download mappings, and
inspect npm pack output for OpenClaw, Pi, and dsh. Pi and dsh actual tarball
checks passed with 14 and 17 skills respectively. A separate OpenClaw actual
tarball check confirmed research and both stage callers byte-for-byte. All
seven research procedure bodies match after removing host notes/frontmatter;
all seven new skills passed
frontmatter validation. Pi's offline suite passed (43 static checks, 110
tests, one existing skip). All 54 dsh unit tests passed with
`CHORUS_AGENT_PROFILE` unset for the test process. The first run inherited the
worker profile and failed three existing wrapper credential-selection
assertions; no wrapper implementation or fixture was changed.

Directory discovery is preserved for Claude and Codex. OpenClaw's manifest and
Pi's package configuration continue to point to `./skills`. dsh's existing
`customSkillDirs` injection still resolves the package's `skills` directory.
The dsh host smoke test's expected skill list now includes research; this
verification does not run that external pinned-harness test or reactivate the
dormant daemon backend.

## Scenario walkthrough

These are self-checks by reading and following the new instructions with
synthetic inputs, not independent agent evaluations or live web/API runs.
No synthetic source or UUID was saved to Chorus. The shared procedure was
compared across all seven ports, allowing host invocation and namespace
differences. Each trace below follows the delivered route and return boundary.

| Input | Result of walkthrough |
| --- | --- |
| Focused, form-created Idea; unknown supported library version; no research flag | Idea Step 4.45 supplies the factual gap to research before formal questions; caller attaches findings and then elaborates. Same route applies to MCP-created Ideas. |
| User says “skip research”; initial instruction carries `researchFirst: true` | Shared precedence returns skipped without retrieval; normal initialization continues. |
| `researchFirst: false` or omitted; existing evidence answers the relevant facts | Automatic judgment reuses evidence; no search is needed. The false flag is not a prohibition. |
| Goal/preference is missing | Caller focuses through the existing question/brainstorm gate. After direction selection, research may run once before synthesis; evidence never substitutes for user choice. |
| Search unavailable or restricted | Research returns limitations and unknowns; caller continues normal clarification/drafting without invented sources. |
| Two useful sources, then no new evidence | Return the supported facts, implications and stop reason. No third-source quota or fabricated citation. |
| Time/source budget exhausted | Check before the next tool call, stop initiating searches, return partial findings. An uninterruptible call does not create a hard five-minute SLA. |
| Comment wake or brainstorm detour after an investigation | Read existing findings and request/session context; reuse rather than restarting. An ended turn or reference count alone is not completion evidence. |
| Proposal preparation after Idea research; same facts | Reuse Idea evidence; no automatic repeat. A new design question can justify one new focused round. |
| New Proposal with a genuinely new source | Retain candidate URL/title/type, create container with inline references, read `references[].uuid`, then write citations. Container UUID is never used as evidence UUID. |
| New evidence in OpenSpec or spec-lite mode | Caller updates authoritative local files, then mirrors file bytes via `--arg-file`; spec-lite durable `spec.md` remains local-only. |
| Tracker request with pending answers, or approved Proposal with only open/assigned tasks | Caller rechecks eligibility from actual development facts. If eligible, research returns findings; caller merges the latest Idea body, saves real citations, reports, and returns. No question/answer/resolution reset or task/approval transition. |
| Development starts after Tracker dispatch, or Idea is complete | Pre-execution eligibility check stops the request without research or body edits. Skill guidance relies on the separate server task for authoritative enforcement. |
| Tracker finding affects approved scope | Save impact and needed revision in the Idea; do not edit locked drafts or expand approved tasks. |
| A new explicit Tracker request after a finished round, still pre-development | One new bounded round is allowed; reuse prior evidence first. Re-entry of the same request is not a new invocation. |

## Version judgment

The maintenance guide normally requires package-wide version bumps for any
plugin edit. This implementation keeps current versions because the assignment
excludes release work and unrelated version churn; coordinated versioning and
publication remain with the parent/release workflow. No push, merge, release,
OpenSpec edit, new MCP tool, or application/service change is part of this task.
