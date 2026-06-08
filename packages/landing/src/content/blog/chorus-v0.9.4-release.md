---
title: "Chorus v0.9.4: OpenClaw shipped an SDK, Codex changed its hooks, and a pile of fixes"
description: "OpenClaw 2026.4.27 introduced a Plugin SDK. Codex reworked how hooks load. Both Chorus client plugins were rewritten to keep up — and the main repo got a month's worth of rough edges sanded down along the way."
date: 2026-06-08
lang: en
postSlug: chorus-v0.9.4-release
---

# Chorus v0.9.4: OpenClaw shipped an SDK, Codex changed its hooks, and a pile of fixes

[Chorus](https://github.com/Chorus-AIDLC/Chorus) v0.9.4 is out. It has been exactly a month since v0.9.0. The 0.9.1, 0.9.2, and 0.9.3 releases shipped without blog posts, so this one covers the whole month at once.

The most important work this month wasn't in the main repo. It was on the two third-party client plugins. OpenClaw rolled out an official Plugin SDK in 2026.4.27, and Codex changed how its hooks load. Chorus has plugins on both sides; falling behind would just break them. So 0.9.2 and 0.9.3 went mostly into rewriting both plugins to match the new conventions.

In the main repo, this month was about smoothing rough edges that 0.9.x had been hitting in real use: the elaboration loop, acceptance criteria, the cost of fetching a proposal, and visibility of completion reports.

---

## OpenClaw shipped a Plugin SDK; the Chorus plugin was rewritten on top of it

[OpenClaw](https://github.com/OpenClaw-AI/OpenClaw) 2026.4.27 was the first release with an official Plugin SDK. Before that, writing a plugin meant doing everything by hand: hand-wrapping each tool, bridging in external behavior through HTTP hooks, and pulling reviewers out by polling SSE yourself. It worked, but every piece routed *around* OpenClaw rather than *with* it.

The old Chorus OpenClaw plugin was that kind of build. Functional, but expensive to maintain — every minor OpenClaw bump risked breaking something.

v0.9.2 was the chance to throw the old shape out and rebuild on top of the SDK:

**MCP registration is native now.** The plugin calls the SDK's `mutateConfigFile` and lets OpenClaw add the Chorus MCP server to its config itself. No more hand-wrapping tools.

**Entry point is `definePluginEntry`.** Activation is declared as `activation.onStartup`, so OpenClaw loads the plugin when it boots. No external script needed to wire it up.

**SSE → agent wake goes through `runEmbeddedAgent`.** The old design simulated a wake by enqueueing a system event plus a heartbeat. Timing was fragile — drop one event and the reviewer didn't run. The new SDK gives you an embedded-agent entrypoint directly: pass it a prompt, done.

**Reviewers are OpenClaw skills, not Claude-Code agent definitions.** The old plugin reused Claude Code agent definitions verbatim, which was a poor fit. They're now native OpenClaw skills, structurally consistent with everything else OpenClaw runs.

**The npm package ships both `src` and compiled `dist`.** Linked installs (developing against source) load TS through jiti; npm installs (end users) use `dist`. Both paths work.

66 new unit tests cover the critical paths. The OpenClaw package version is on its own track — this release is 0.5.3.

---

## Codex plugin: hook loading reworked

The Codex change wasn't dramatic, but the old setup hurt.

Before v0.9.0, installing the Chorus Codex plugin **copied a hook file into the user's home directory**. A few problems followed:

First, on the next Chorus plugin upgrade the old hook copy stayed in the user directory. The new hook also got registered. Net result: the same event ran twice. Activity rows duplicated, checkins fired twice — both seen in the wild.

Second, an old hook might point at functionality that newer versions had retired. The copy kept running anyway, behavior diverging from the docs.

Third, users had no idea this hook lived in `~/.codex/` and no way to know what to clean up.

v0.9.3 fixed all three:

**Hooks now ship inside the plugin package.** Codex reads hooks straight from the plugin at runtime, no copy in user dirs. Plugin upgrade = hooks upgrade. No stale versions lying around.

**The installer cleans the old copies.** When it detects historical Chorus hook entries in the user directory, it asks whether to remove them and explains where they came from.

**Docs and skills are updated.** Codex plugin skill docs got swept to align with the current hook surface — no more outdated instructions.

The fix looks like a bug patch, but it also nudges the Codex plugin's operational model in a sustainable direction: upgrading is just upgrading. Users don't have to clean up after themselves anymore.

---

## Main repo: elaboration is a loop, not a one-shot

The biggest change in the main repo this month was the elaboration flow.

Idea elaboration in Chorus has always run as a structured multi-choice session: call `start_elaboration` to generate a round, the agent calls `answer_elaboration`, then `validate_elaboration` finalizes. On paper that's a clean three-step "ask → answer → resolve."

In practice it doesn't work like that. After an agent answers a round, what comes next depends on what the answer surfaced. Sometimes things wrap up cleanly. Sometimes the answer raises new uncertainty and another round is needed. Sometimes a human reviewer reads the output and finds an angle that wasn't covered. The old API forced these three cases into different code paths, each one a little awkward.

`validate_elaboration` used to operate per-round: each round could be marked `validated` or `needs_followup`. This looked flexible, but round status and "is the Idea fully clarified?" are different things. An Idea might have three rounds where the first two are clean and the third is still in flight. The Idea itself is obviously not done, but the first two rounds are already `validated`. Two truths, no clear winner.

`answer_elaboration` had a `roundUuid` parameter that was always required. But at any given moment, an Idea has at most one active round. The agent had to look it up and pass it back — a pure ceremony.

The worst case: wanting to add one more question after elaboration was already done. An Idea has been resolved and a proposal is in flight. A reviewer reads the proposal, finds an edge case that wasn't clarified, wants to ask one more question. The old model offered nothing for this. You either reverted the Idea to `elaborating` (which would then block the in-flight proposal), or skipped elaboration entirely.

v0.9.4 reshaped this around what it actually is:

First, **`start_elaboration` is the only way to ask new questions.** First round, follow-up round, post-resolve append — all the same call. Appended rounds carry `isAppended=true` and the UI shows a "Follow-up" badge; the Idea stays resolved, so a running proposal isn't blocked.

Second, **`answer_elaboration`'s `roundUuid` is now optional.** An Idea can only have one `pending_answers` round at a time, so the tool finds it itself.

Third, **`validate_elaboration` is now Idea-level.** It does one thing: marks the Idea's `elaborationStatus` as `resolved`. Precondition: the Idea has at least one round and every round is already `answered`. It never touches a round's status. Active round states are now just `pending_answers → answered`; the legacy `validated` / `needs_followup` values stay on existing data but are no longer written.

Fourth, **the loop is explicit in the skills.** The idea / yolo skills spell it out: after each answer, decide what comes next. To follow up, call `start_elaboration` again. Loop until the agent (in YOLO mode) or the human reviewer (in normal mode) decides things are actually clear, then validate. No more implicit "one round and done" assumption.

It's the biggest single quality-of-life change in this batch.

---

## Tasks must have acceptance criteria

Chorus tasks have always supported `acceptanceCriteriaItems`. They're the core of the verification flow. But until 0.9.3, AC was optional — if you didn't pass any, the task simply had no checklist.

That sounds harmless. It isn't. A task with no AC reaches verify with nothing for the reviewer to check against, so review collapses to "does this look right?", which is barely review. The most common offender is an agent batch-creating tasks from a vague prompt and forgetting AC entirely.

v0.9.3 makes AC a hard requirement. `chorus_pm_add_task_draft` and `chorus_create_tasks` reject empty AC at creation time. `create_tasks` is all-or-nothing — one bad task rejects the whole batch. The validator lives in `src/lib/acceptance-criteria.ts` as the single source of truth shared by the proposal service and the MCP tool handlers.

Update endpoints use partial semantics: AC provided must be non-empty (replaces existing); AC omitted is preserved. So status changes, dependency edits, and other AC-irrelevant updates keep working without resending the criteria.

v0.9.4 brings the UI in line. The Task Draft panel uses a structured row editor (one row per criterion, each with a required-toggle), but the real Task edit form had been a plain Markdown textarea. Same field, completely different UX. The structured editor is now a shared component used by both panels. Real-task edits go through the existing `replaceAcceptanceCriteria` service. The destructive replace only fires when the criteria set actually changed — so editing a title or status doesn't wipe the verification ticks you already earned.

---

## Don't fetch the whole proposal every time

`chorus_get_proposal` used to be a heavy tool: pass `proposalUuid`, get back proposal metadata + every document draft's full Markdown + every task draft's full fields. A real proposal with three docs and a dozen tasks easily blew past 10K content tokens.

In actual workflows, agents mostly just want a directory: "this proposal has N docs and M tasks; here are their titles." If they need the full body of one of them, they drill in. The old API forced them to swallow everything, every call.

v0.9.2 added a `section` parameter: `basic` (the new default) returns metadata plus a lightweight index (uuid, type, title, content length); `documents` returns the full document bodies; `tasks` returns full task fields; `full` is the original everything-at-once behavior.

The implementation layers a pure projection (`getProposalSection()`) over the untouched `getProposal()`, so the REST route and the frontend are unchanged and existing callers keep working. The skills updated their callsites: reviewers use `section:full` (review needs everything), develop / task-reviewer use `section:documents` (load docs on demand), everything else gets the basic default.

The change looks small, but across a real session full of repeated proposal lookups, the total tokens pulled drops from tens of thousands to a few thousand.

---

## Make the report visible after it's written

v0.9.0 added end-of-Idea summary reports. But back then, the report just landed in the database. Nothing announced it. You had to actively open the Idea detail page to discover it. "Available on demand" isn't enough for a formal summary.

v0.9.1 wired reports into the notification stream. After `chorus_create_report` writes successfully, it emits SSE events, records an Idea-targeted Activity, and fires bell notifications to the Idea creator, assignee, and their human owners. Clicking the notification deep-links to the dashboard's Idea panel. These side effects in `document.service` are best-effort — an event-emit failure won't roll back the document insert.

A duplicate-write fix went in at the same time. The `/yolo` flow had two independent paths nudging "time to write the report": a PostToolUse hook reminder, and the skill's own Phase 5b end-step. Both fired against the same proposal, sometimes producing two reports. `chorus_create_report` now takes a `force: boolean` param (default `false`). With `force` omitted or false, attempting to write a second report on the same proposal returns an MCP error with no write. Pass `force=true` to opt back in to multi-report semantics for explicit re-authoring.

---

## Odds and ends

**Creating an API key is no longer a dead end.** Before, creating an agent key from Settings landed you on a success screen with a "Done" button and the raw key — nothing about what to do next, which client to install, or how. Onboarding already had a complete 5-client install guide. v0.9.4 extracts that guide into a shared `AgentInstallGuide` component, used by both Settings and onboarding. The new key is embedded in the example config, ready to copy and paste.

**IME no longer eats characters.** CJK / Japanese / Korean IME users hitting Enter to confirm a candidate word were losing their in-progress text — the keystroke was firing form submit, dialog close, or search navigate instead. v0.9.1 added an `isImeComposing(e)` helper (checks `nativeEvent.isComposing` plus a Safari `keyCode === 229` fallback) and routed all 7 affected Enter handlers through it. CLAUDE.md gained a rule: any future Enter handler must go through this helper first.

**@-mention popups inside modals are clickable again.** Proposal comments open inside a Sheet (a Radix Dialog). The editor's @-mention popup was being attached to `document.body`, which meant the surrounding Dialog's `pointer-events:none` blocked it: keyboard navigation worked, but clicking dismissed the dialog. v0.9.2 moved the popup inside the editor's own wrapper. It's still `position:fixed` so it escapes overflow clipping, but `pointer-events` now propagates correctly.

**Plugin versions aligned.** Across 0.9.1 / 0.9.2 / 0.9.3 / 0.9.4, the Claude Code and Codex plugins moved in lockstep with the main version. All four skill surfaces (Claude Code plugin, Codex plugin, OpenClaw plugin, standalone `/skill/`) got their docs updated together. The standalone `/skill/` package in 0.9.3 also picked up the previously-unregistered yolo / proposal-reviewer / task-reviewer / brainstorm / quick-dev skills, so it's now a complete set.

---

## Upgrade

```bash
npx @chorus-aidlc/chorus@latest
```

Claude Code plugin:

```bash
/plugin marketplace update chorus-plugins
```

Codex plugin: re-run the installer per the release docs. It will offer to clean up legacy hook copies — see the Codex section above.

OpenClaw plugin:

```bash
npm i -g @chorus-aidlc/openclaw-plugin@latest
```

Heads-up on a few breaking changes:

- `chorus_pm_validate_elaboration` now takes only `ideaUuid`. The old `roundUuid` parameter is gone. Any script that passed it needs to drop it.
- Task creation requires AC. `chorus_pm_add_task_draft` / `chorus_create_tasks` calls that previously got away with empty AC will now fail.

v0.9.4 is on [GitHub Releases](https://github.com/Chorus-AIDLC/Chorus/releases/tag/v0.9.4) and [npm](https://www.npmjs.com/package/@chorus-aidlc/chorus).

Questions or feedback? [GitHub Issues](https://github.com/Chorus-AIDLC/Chorus/issues) or [Discussions](https://github.com/Chorus-AIDLC/Chorus/discussions).

---

**GitHub**: [Chorus-AIDLC/Chorus](https://github.com/Chorus-AIDLC/Chorus) | **Release**: [v0.9.4](https://github.com/Chorus-AIDLC/Chorus/releases/tag/v0.9.4)
