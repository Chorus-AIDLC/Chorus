# Align plugin skill docs with the real harness tools and behavior

## Why

A full `/chorus:yolo` run on 2026-09-09 (plugin 0.17.3, project "CWD Wake Test (throwaway)",
idea `b13e2c10`, proposal `dacb937b`, 8 tasks all delivered) completed the AI-DLC pipeline, but the
agent had to silently work around three places where the shipped skill text describes tools or
behavior that do not exist in the running harness. Each one costs an agent a wasted detour and, worse,
makes it doubt its own tool usage — the failure mode is *the agent believing it is calling things
wrong* while the docs are the thing that is wrong.

All three were re-verified against `develop` (see `design.md` for the exact per-file footprint):

1. **`TeamCreate` does not exist.** `yolo` Phase 3 tells the agent to call
   `TeamCreate({ team_name: "yolo-wave-{wave}" })` before spawning per-task agents, and frames
   sequential execution as the "if `TeamCreate` fails" fallback. Claude Code exposes no such tool.
   The same instruction also sits in `develop` and, on two surfaces, in `quick-dev` — so it is not a
   yolo-only bug. Notably `openspec/specs/openclaw-skills/spec.md` **already requires** that the
   OpenClaw skills "MUST NOT instruct the agent to call a Claude-Code-only `TeamCreate` primitive as
   a hard requirement" — that surface is currently in violation of its own archived spec.

2. **The reviewer "foreground / synchronous" promise is not deliverable.** Skill text and the
   PostToolUse hook injections both insist the agent spawn `chorus:proposal-reviewer` /
   `chorus:task-reviewer` / `chorus:code-reviewer` "in **foreground** (do NOT set
   `run_in_background`)" and that the call "waits and returns the VERDICT inline". In Claude Code
   these subagent types return `Async agent launched successfully` regardless of the flag; the
   verdict is only readable from a `VERDICT:` comment after the completion notification arrives. The
   *behavior* is fine — the promise is what is wrong, and because the hook text is injected at
   runtime it outranks anything we fix in `SKILL.md` alone.

3. **`.chorus/specs/TEMPLATE/` does not ship.** The `spec-lite` skill tells the agent to copy
   `.chorus/specs/TEMPLATE/spec.md` and `.chorus/specs/TEMPLATE/YYYY-MM-DD-change/prd.md`; the
   directory exists in no plugin payload and in no target repo. `proposal` and `yolo` restate the
   same dangling copy instruction. The escape hatch ("or the skill's inline shape if the template
   isn't present") only covers `spec.md` — the dated-folder documents' frontmatter (`proposalUuid`,
   `documentUuid`) is left for the agent to guess, which directly threatens the byte-exact mirror
   contract those ids drive.

Elaboration (round 1, 5 questions, resolved 2026-09-09) settled the approach: generalize the
parallel-agent instruction rather than gate `TeamCreate`; fix the reviewer wording in skills **and**
hooks; replace `TEMPLATE/` with complete inline templates (no new files, no new hook work); apply
across **all** distribution surfaces; and split the three incidental observations out into their own
ideas so this change stays a fidelity fix.

## What Changes

- **`TeamCreate` → harness-neutral parallel dispatch.** Remove every `TeamCreate` call and every
  "if `TeamCreate` fails" framing from `yolo`, `develop`, and `quick-dev` on every surface that
  carries them. Replace with a generic instruction: dispatch one sub-agent per unblocked task using
  the harness's own sub-agent primitive, issuing the whole wave in a single message so it runs in
  parallel; fall back to sequential main-agent execution when sub-agent dispatch is unavailable or
  repeatedly fails. No surface gains **another** harness's tool name — `public/skill/` stays free of
  all of them and `packages/chorus-pi/`'s static test (`test/static.sh:84`) rejects foreign ones. A
  surface's references to its *own* primitives are legitimate and are left in place.

- **Reviewer wait contract → "wait with your harness's mechanism, then read this round's VERDICT
  comment".** State the contract positively instead of denying a return behavior: every reviewer-spawn
  site tells the agent to wait using a mechanism its own harness actually provides, then to read and act
  on the `VERDICT:` comment for *this* round (same entity, posted after this dispatch) via
  `chorus_get_comments`, and never to advance before reading it. Each harness keeps its real waiting
  primitive — Codex `wait_agent`, OpenClaw `sessions_yield`, dsh `run_in_background: false`, Pi's
  blocking `subagent` — and where a primitive verifiably returns the verdict, saying so stays allowed
  (Pi's does; `packages/chorus-pi/skills/review/SKILL.md:67` is accurate and is left alone). What gets
  removed is the untrue part: on Claude Code, "in **foreground** (do NOT set `run_in_background`)" and
  "waits and returns the VERDICT inline", replaced by the observed async-launch + completion-notification
  behavior. No surface gains an unverified claim about its own spawn semantics. Both PostToolUse hook
  injections are corrected in the same change, since they override the skill text at runtime.

- **`spec-lite` templates → inline.** Delete all `.chorus/specs/TEMPLATE/` references from
  `spec-lite`, `proposal`, `yolo` (and `docs/SPEC_LITE.md`) and give `spec-lite` complete inline
  templates: the full durable `spec.md` skeleton, and a frontmatter template for each dated-folder
  document showing `title` / `proposalUuid` / `documentUuid` (the document type being implied by the
  filename, not carried as a frontmatter key — a deliberate deviation from the q3 option text, see
  `design.md`). Nothing new is shipped and no hook changes.

- **A CI guard so this cannot silently rot again — three checks, no template detection.** A new shell
  guard, wired into the existing plugin-shell-tests CI step, fails when any shipped skill or hook
  reintroduces `TeamCreate`, an inline-verdict/foreground reviewer promise, or a `.chorus/specs/TEMPLATE/`
  path. Per the owner's instruction the templates are simply inlined and **not** verified by CI, so there
  is no template-presence check. The guard matches **literal** offending phrases, excludes its own source
  file, and scopes the reviewer-promise check to the three surfaces this change rewrites — so it cannot
  flag the corrected wording (which legitimately keeps dsh's `run_in_background: false`) or Pi's accurate
  blocking-subagent text. It deliberately does **not** claim to protect the review gate: no grep proves
  the "do not advance before reading the verdict" paragraph still exists, so that property is carried by
  per-task acceptance criteria and review instead.

- **Out of scope, split to their own ideas** (per elaboration q5): task acceptance criteria being
  immutable after proposal approval; an Idea remaining `elaborated` after every task is done; and
  `chorus:proposal-reviewer` having no `Bash` tool (which produced one false "spec folder does not
  exist" finding).

## Capabilities

- `skill-harness-fidelity` (new): shipped skill/hook text must only reference primitives the target
  harness actually exposes, must promise only behavior its own harness provides (wait with a real
  mechanism, then read this round's `VERDICT:` comment before advancing — never a wait or return
  semantic that harness does not have), and must be self-sufficient (no references to unshipped
  files). The three literal drifts are additionally pinned by an automated guard across every
  distribution surface.

## Impact

- **Docs/prompt-only for the plugin payloads** — Markdown skill bodies, Kiro agent manifest prose,
  two Claude Code hook scripts, three Kiro hook scripts, and the dsh wake-prompt strings in
  `packages/chorus-dsh/src/index.ts`. No MCP tool, service, schema, or API change.
- **Behavioral effect on agents:** yolo/develop waves dispatch without a phantom tool call; the
  reviewer gate stops promising something the harness cannot do; spec-lite runs are self-sufficient.
- **Risk:** a surface is missed, or a rewrite changes the *gate* semantics (an agent that stops
  waiting for verdicts would ship unreviewed work). The missed-surface risk is covered by the CI guard;
  the gate risk is **not** — it is covered only by explicit acceptance criteria that the "do not advance
  before you have read this round's verdict" requirement survives at every rewritten site, plus review.
