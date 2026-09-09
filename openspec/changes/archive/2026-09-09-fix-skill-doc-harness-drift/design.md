# Technical Design: skill/harness fidelity fix

## Overview

Prompt-and-docs change only. Three independent drifts, each with a different (and only partly
overlapping) per-surface footprint, plus one CI guard that pins all three shut. Nothing here touches
`src/`, Prisma, MCP tool definitions, or the REST surface.

The single design principle: **shipped skill text may only promise what the target harness actually
provides.** Where surfaces differ, the text becomes harness-neutral rather than picking one harness's
vocabulary.

## Surface inventory (verified on `develop`, 2026-09-09)

Seven distribution roots carry stage-skill content. Not every root is affected by every drift — this
matters, because "fix all surfaces" must not mean "edit files that were already correct".

| Root | Harness | TeamCreate | Reviewer wait claim | `specs/TEMPLATE` |
|---|---|---|---|---|
| `public/chorus-plugin/` | Claude Code | `skills/yolo` (2), `skills/develop` (1) | `skills/yolo` (4), `skills/review` (4), `skills/develop` (2), `bin/on-post-submit-proposal.sh` (1), `bin/on-post-submit-for-verify.sh` (1) | `skills/spec-lite` (2), `skills/proposal` (1), `skills/yolo` (1) |
| `plugins/chorus/` | Codex | — | — (uses `wait_agent`; no inline-verdict claim) | `skills/spec-lite` (2), `skills/proposal` (1), `skills/yolo` (1) |
| `public/kiro-plugin/` | Kiro | — | `.kiro/skills/chorus-review` (4), `chorus-yolo` (3), `chorus-develop` (2), `.kiro/agents/chorus.md` (1), `bin/on-post-submit-proposal.sh` (1), `bin/on-post-submit-for-verify.sh` (1), `bin/on-post-verify-task.sh` (1) | `.kiro/skills/chorus-spec-lite` (2), `chorus-proposal` (1), `chorus-yolo` (1) |
| `packages/openclaw-plugin/` | OpenClaw | `skills/yolo` (2), `skills/develop` (2), `skills/quick-dev` (1) | — (uses `sessions_spawn` + poll) | `skills/spec-lite` (2), `skills/proposal` (1), `skills/yolo` (1) |
| `packages/chorus-dsh/` | dsh | `skills/yolo-chorus` (1), `skills/develop-chorus` (2), `skills/quick-dev-chorus` (1) | `skills/yolo-chorus` (4), `review-chorus` (3), `develop-chorus` (2), `chorus` (1), `orchestrate-chorus` (1), `proposal-chorus` (1), `quick-dev-chorus` (1), `src/index.ts` (3 wake-prompt strings) | `skills/spec-lite-chorus` (2), `skills/yolo-chorus` (1) |
| `packages/chorus-pi/` | Pi | — (`test/static.sh` **forbids** the name) | — (**accurate as written**: `skills/review/SKILL.md:67` documents Pi's bundled `subagent` as genuinely blocking, and `lib/lib.ts:199-217` distinguishes that blocking tool from the third-party detached one) | `skills/spec-lite` (2), `skills/proposal` (1), `skills/yolo` (1) |
| `public/skill/` | harness-neutral | — | — (already "spawn a read-only sub-agent … read its VERDICT comment") | — (no spec-lite skill) |

Non-plugin doc site: `docs/SPEC_LITE.md` (2 × `specs/TEMPLATE`).

**Totals (re-counted with `git ls-files | xargs grep -c`, 2026-09-09):** `TeamCreate` = **12**
occurrences in shipped skills (CC 3, OpenClaw 5, dsh 4) plus 3 in `packages/chorus-pi/test/` that
forbid it. `specs/TEMPLATE` = **25** (23 in shipped skills across 6 roots + 2 in `docs/SPEC_LITE.md`),
excluding the frozen `.chorus/specs/spec-lite/2026-09-08-chorus-native-lite/tech_design.md`.

Two facts from that table drive the design:

- `public/skill/` and `packages/chorus-pi/` are **already correct** on drifts 1 and 2, and
  `packages/chorus-pi/test/static.sh:84` (check "A6. no Claude/Codex product residual") actively fails
  the build if `TeamCreate`, `run_in_background`, `Agent({`, or `subagent_type` appear in its skills.
  So the replacement wording for drift 1 must be expressible **without naming another harness's
  tool**, or the pi port cannot carry it.

  **What "harness-neutral" does and does not mean.** A6 bans *other* harnesses' vocabulary, not tool
  names as such: Pi's skills legitimately name Pi's own primitive `subagent` (verified at
  `packages/chorus-pi/skills/review/SKILL.md:67`), and
  `public/skill/` names none because it targets no single harness. So the constraint on drift 1 is
  "do not name a foreign harness's primitive", not "strip every tool name". An implementer must not
  read this change as a licence to delete Pi's accurate local tool guidance.
- `openspec/specs/openclaw-skills/spec.md:51` already forbids the `TeamCreate` instruction on the
  OpenClaw surface. Fixing drift 1 there is a spec-compliance repair, not a new requirement.

## Drift 1 — `TeamCreate` → generic parallel dispatch

Replacement shape for the yolo Phase 3 / develop / quick-dev wave loop (harness-neutral prose, no
tool name):

1. Find unblocked tasks (`chorus_get_unblocked_tasks`).
2. Dispatch **one sub-agent per unblocked task using the harness's own sub-agent primitive**, issuing
   the whole wave **in a single message** — that is what makes them run in parallel; there is no team
   or group object to create first.
3. Wait for the wave to finish, then run Phase 4 verification for those tasks.
4. **Fallback** (unchanged behavior, corrected trigger): if the harness offers no sub-agent
   dispatch, or sub-agents repeatedly fail, execute tasks sequentially as the main agent.

Per-surface, the harness primitive is named only where that surface already names it (Claude Code
`Agent`, OpenClaw `sessions_spawn`, dsh's own spawn tool); pi/`public/skill` keep the neutral phrasing.
The old "if `TeamCreate` fails" sentence is rewritten, not deleted — the sequential path stays.

## Drift 2 — reviewer wait contract

The invariant to preserve is the **gate**, not the mechanism:

> After spawning a reviewer you MUST NOT advance the pipeline (approve/reject, verify/reopen, ship)
> until you have that reviewer's `VERDICT:` comment.

The false part is *how* the verdict arrives — but only on some surfaces. The contract is therefore
written as a **positive** cross-harness requirement rather than as a blanket denial of inline return:

> Spawn the reviewer, **wait for it to complete using whatever mechanism this harness provides**, then
> read **this round's** `VERDICT:` comment for the target entity with `chorus_get_comments` and act on
> what it says. Do not advance the pipeline before you have read that comment.

Two clauses of that formulation are deliberate:

- **"whatever mechanism this harness provides"** — each surface fills in its own true mechanism: a
  completion notification (Claude Code), a blocking call (Codex `wait_agent`, Pi's bundled `subagent`,
  dsh `run_in_background: false`), or poll/yield (OpenClaw `sessions_yield`). No surface is told to use
  a mechanism it does not have, and no surface is told its blocking call *doesn't* return a result when
  it demonstrably does. `packages/chorus-pi/skills/review/SKILL.md:67` is the concrete case: Pi's
  bundled `subagent` really is blocking and really does return the VERDICT, and
  `packages/chorus-pi/lib/lib.ts:199-217` documents exactly that distinction against the third-party
  detached tool. An earlier draft of this change forbade *any* claim of inline return, which would have
  condemned true Pi text while simultaneously leaving Pi out of scope — a contradiction.
- **"this round's comment … and act on what it says"** — the read is what makes the gate real, whatever
  the spawn returned. "This round's" means: comment on the entity under review, posted after the current
  dispatch, from the reviewer role in question — not merely the newest `VERDICT:` on the entity, which
  on a re-review may be the previous round's. When no such comment exists, the existing respawn-once /
  manual-review / escalate-after-3-FAIL path applies unchanged; the agent must not treat absence as PASS.

Only the Claude Code surface asserts asynchrony, and it asserts it about itself: these reviewer
subagent types have been observed to return `Async agent launched successfully` regardless of the flag
in this repo's plugin as configured. Nothing here asserts async — or its absence — for Kiro or dsh,
whose spawn semantics were not verified.

Consequences per surface:

- **Claude Code** (`public/chorus-plugin`): remove "in **foreground** (do NOT set
  `run_in_background`)" from the 10 skill sites; rewrite the two hook injections
  (`on-post-submit-proposal.sh:60`, `on-post-submit-for-verify.sh:60`, both currently "Run the
  reviewer synchronously (do NOT set run_in_background). Wait for its VERDICT before proceeding.").
  Hook text is injected at runtime and therefore takes precedence over `SKILL.md` — fixing only the
  skills would leave the wrong contract live, which is exactly how this drift survived.
- **Kiro** (`public/kiro-plugin`): same rewrite across 4 skill/manifest files and 3 hook scripts.
  Kiro's subagent mechanism is not asserted either way — the "wait with your mechanism, then read this
  round's comment" formulation is true whether its spawn blocks or not, and the rewrite MUST NOT add a
  claim that Kiro's spawn does or does not return a verdict.
- **dsh** (`packages/chorus-dsh`): 7 skills plus the three wake-prompt strings in `src/index.ts`,
  which today say "spawn the reviewer sub-agent with `run_in_background: false` (foreground — the call
  waits and returns the VERDICT inline…)". Keep `run_in_background: false` as dsh's *way of waiting* —
  it is real — and add the read of this round's `chorus_get_comments` verdict as what the decision is
  based on. Drop only the part that is unverified for dsh, namely that the tool result *is* the verdict;
  say instead that the verdict is read from the comment.
- **Codex / OpenClaw / `public/skill` / pi**: **one minimal edit each, and nothing else.** All four
  already wait and then read a `VERDICT:` comment, but they say *"the most recent"* comment, which on a
  second review round can be the previous round's verdict. Since the requirement is universal, that
  phrase is tightened to this round's comment (same entity, posted after the current dispatch) on these
  surfaces too — a one-clause substitution per site, no restructuring. Everything else on these four
  surfaces, in particular Pi's true blocking-return sentence, is left byte-identical. The alternative —
  asserting a universal round-matching contract while leaving four surfaces phrased the old way — would
  reintroduce exactly the doc-vs-reality gap this change exists to close.
  For reference, the waiting mechanism each already gets right and keeps
  (Codex `wait_agent`; OpenClaw `sessions_yield` / `subagents` poll at
  `packages/openclaw-plugin/skills/review/SKILL.md:69`; Pi's blocking `subagent` plus its own
  `chorus_get_comments` step). Pi's statement that its blocking tool returns the VERDICT is accurate for
  Pi and stays.

`packages/chorus-dsh/tests/spec-mode.test.ts` and the dsh package tests that assert on those prompt
strings must be updated in the same task, or the change lands red.

## Drift 3 — inline spec-lite templates

Delete the `.chorus/specs/TEMPLATE/…` copy instructions and give `spec-lite` two inline templates.

Durable spec (`.chorus/specs/<slug>/spec.md`) — local only, **no Chorus ids**:

```markdown
---
slug: <kebab-case-capability>
title: <Capability title>
status: draft            # draft | active | done
created: <YYYY-MM-DD>
---

## Intent
<what this capability is for, in prose>

## Requirements
<prose, no SHALL/scenario grammar>
- [ ] <acceptance point>

## Non-goals
- <explicitly out of scope>
```

Dated-folder document (`.chorus/specs/<slug>/<YYYY-MM-DD>-<change-slug>/<type>.md`) — **synced**, so
it carries the mirror ids; `type` is implied by the filename and is NOT a frontmatter field:

```markdown
---
title: <Document title as it appears in Chorus>
proposalUuid: <uuid>      # written on first mirror
documentUuid:             # empty until the draft materializes on approval
---

# <Document title>
<body — this file's bytes are the source of truth for the Chorus Document>
```

Both templates go in `spec-lite`, inlined verbatim into the skill body — nothing is generated, copied,
or verified at runtime or in CI. `proposal` and `yolo` stop naming a template path and instead point at
the `spec-lite` skill's inline templates. `docs/SPEC_LITE.md` follows.

Frontmatter-key note: the two ids are exactly what §"Mirror" in `spec-lite` already relies on
(`documentUuid` / `(proposalUuid, type)` resolution), so the template makes an existing contract
explicit rather than inventing one.

**Deliberate deviation from elaboration q3.** The q3 option text listed the dated-folder frontmatter as
"`type` / `proposalUuid` / `documentUuid`". `type` is deliberately **not** a frontmatter key: the
shipped `spec-lite` skill already derives the Document type from the filename (`prd.md` → `prd`, …) and
its own §Mirror resolves identity by `documentUuid` / `(proposalUuid, type)` with the type taken from
the file table. Adding a `type:` key would create a second, divergable source for the same fact. The
template therefore carries `title` / `proposalUuid` / `documentUuid` plus an explicit sentence that the
type comes from the filename — satisfying q3's intent (an agent has to infer nothing) without the
redundant key.

## The CI guard

New `public/chorus-plugin/bin/tests/test-skill-harness-fidelity.sh`, following the existing
`test-resolver-drift.sh` conventions (Bash 3.2-compatible, `set -u`, repo root derived from
`$0`, PASS/FAIL tally, non-zero exit on any FAIL), wired into the "Run plugin shell tests" step of
`.github/workflows/test.yml` next to the two existing guards.

Checks, over shipped skill/hook/manifest files under `public/`, `plugins/`, `packages/` (excluding
`node_modules/`, `dist/`, `cdk.out/`, `.claude/worktrees/`, and — mandatorily — the guard's own source
file, which must contain every forbidden literal as a search pattern):

1. **No `TeamCreate`** anywhere. Allowed exception: `packages/chorus-pi/test/static.sh` and
   `packages/chorus-pi/test/README.md`, which name it in order to forbid it.
2. **No inline-verdict / foreground reviewer promise.** Match **literal offending phrases only** —
   `reviewer synchronously`, `returns the VERDICT inline`, `waits and returns the VERDICT`,
   `in **foreground**`, `(do NOT set run_in_background)`. **Do not** use a proximity heuristic pairing
   `run_in_background` with "foreground"/"synchronous"/"inline": the prescribed replacement text
   deliberately keeps `run_in_background: false` on dsh, so a proximity rule would fail the very tree
   this change produces. Every pattern above is chosen so that no prescribed replacement sentence
   contains it as a substring. Scope: `public/chorus-plugin/`, `public/kiro-plugin/` and
   `packages/chorus-dsh/` — the three surfaces this change rewrites. `packages/chorus-pi/` is
   **excluded** from this check, because Pi's `subagent` genuinely blocks and returns the VERDICT and
   its skill says so truthfully; a repo-wide literal sweep would flag correct text.
3. **No `.chorus/specs/TEMPLATE`** path in any shipped skill or in `docs/SPEC_LITE.md`.

**No template-presence check** (owner decision, 2026-09-09: *"不要检测模板，直接内嵌就好"*). The inline
templates are simply written into `spec-lite`; CI does not assert they are still there. This drops the
whole marker-uniqueness problem (`status: draft` already occurring at
`public/chorus-plugin/skills/spec-lite/SKILL.md:34` and so on) along with it. Check 3 still prevents the
*dangling path* from coming back, which is the failure that actually cost an agent a detour.

**What the guard does and does not guarantee.** It pins the three literal drifts shut. It does **not**
prove the review gate still exists: none of the three checks would fail if a rewrite deleted the "do not
advance before you have read the verdict" paragraph outright. That property is held by per-task
acceptance criteria (each rewritten site must still carry the gate sentence) and by human/reviewer
review — not by CI. Any claim that CI protects the gate would be false and must not appear in the
shipped docs.

The guard is intentionally grep-based text assertion, matching how the repo already guards plugin
text (`test-syntax.sh`, `test-resolver-drift.sh`, `chorus-pi/test/static.sh`). It is added to the CI
step currently named "Run plugin shell tests (Bash 3.2-compat syntax smoke + spec-mode resolver)" at
`.github/workflows/test.yml:43`, whose `run:` block today invokes `test-syntax.sh`,
`test-spec-mode-resolution.sh` and `test-resolver-drift.sh`; the step name is extended to mention the
fidelity guard.

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| A rewrite weakens the review gate (agent ships without a verdict) | The canonical formulation keeps "do not advance before you have read this round's verdict"; per-task AC requires that sentence at every rewritten site. **CI does not cover this** (see "What the guard does and does not guarantee") — it is an AC + review obligation, and the docs must not claim otherwise |
| A surface is missed | The surface-inventory table is the checklist; guard checks 1 and 3 sweep all roots, so a miss fails CI rather than shipping |
| Asserting a spawn semantic that is untrue for a harness (async for Kiro/dsh, or "no inline verdict" for Pi) | Each surface states only its own verified mechanism; the contract is the positive "wait, then read this round's comment". No text asserts async or its absence for Kiro/dsh, and Pi's true blocking-return statement is left intact |
| pi/`public/skill` neutrality broken by naming a *foreign* tool | Drift-1 replacement prose names no tool by default; a surface may keep its own primitives (`chorus-pi/test/static.sh:84` bans other harnesses' names, not Pi's `subagent`) |
| dsh package tests assert the old prompt strings | Updated in the same task as the dsh prompt rewrite |
| The guard flags the fix itself (its patterns match prescribed wording, or its own source) | Check 2 uses literal phrases only, never a `run_in_background`+"inline" proximity rule, and excludes `packages/chorus-pi/`; the guard excludes its own file; one AC requires a clean PASS on the corrected tree |
| The agent reads a *stale* verdict from a previous review round and advances | The contract requires this round's comment (target entity, posted after the current dispatch, from the reviewer role in question); absence triggers the existing respawn-once / manual / escalate path, never a default PASS |

## Out of scope

Split to their own ideas per elaboration q5: post-approval AC immutability; Idea not closing after all
tasks are done; `chorus:proposal-reviewer` lacking `Bash` (false "folder missing" finding).
