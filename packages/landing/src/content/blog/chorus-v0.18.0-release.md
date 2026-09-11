---
title: "Chorus v0.18.0: Lightweight local specs, built in"
description: "Not every change needs the full OpenSpec workflow. Chorus now includes a smaller, Git-native option."
date: 2026-09-11
lang: en
postSlug: chorus-v0.18.0-release
---

# Chorus v0.18.0: Lightweight local specs, built in

OpenSpec is a good fit when a change needs detailed design, strict validation, and a specification that will keep growing. Not every project or change needs the full workflow.

Sometimes the useful minimum is one current spec committed beside the code, plus a PRD or technical design for the change at hand. Until now, Chorus did not have a standard local-spec path for projects that chose not to use OpenSpec. The details often ended up back in chat history and temporary notes.

Chorus v0.18.0 adds `spec-lite`, a built-in lightweight complement to OpenSpec. It does not replace OpenSpec. Projects that already use OpenSpec keep the same workflow; projects that want less ceremony can manage specs as ordinary Markdown in the repository.

## One durable spec, plus documents for each change

spec-lite keeps one evolving local spec for each capability:

```text
.chorus/specs/<slug>/spec.md
```

That file records the capability's current Intent, Requirements, and Non-goals. It is committed to Git and never synced to Chorus. Later changes update the same file, so its Git history becomes the history of the capability.

Each individual change gets a dated directory. It must contain `prd.md`; `tech_design.md`, `adr.md`, and other documents are optional:

```text
.chorus/specs/<slug>/2026-09-11-<change-slug>/
```

These change documents are mirrored byte-for-byte into Chorus as Document Drafts. They become regular Documents after the Proposal is approved. Task state stays in Chorus, so there is no second `tasks.md` to maintain.

The responsibilities stay clear:

- `.chorus/specs/<slug>/spec.md` holds the capability's current local spec
- dated directories record the PRD and design for individual changes
- Chorus Documents provide the mirrored copies used during Proposal review and collaboration
- Chorus Tasks continue to own execution state and verification

When OpenSpec is available, Chorus still prefers it. Otherwise the workflow falls back to spec-lite. You can also select `CHORUS_SPEC_MODE=lite|openspec|off` explicitly. If `openspec` is requested but unavailable, the workflow stops with an error instead of silently switching modes.

Claude Code, Codex, OpenClaw, Kiro, Pi, and dsh all support the same directory and workflow. A different agent can take over without changing the spec format or location.

## Daemon agents can return replies to the original session

Daemon agents can wake one another through Idea assignments, Task assignments, and `@mentions`. One important piece of context was missing: the agent being woken did not know which live session was waiting for its reply.

Suppose Agent A wakes Agent B from an Idea. If B finishes the work and reports back through a separate conversation, A's original session is still waiting. One collaboration has split into two threads.

v0.18.0 adds a live session anchor to these wakes. For an agent-originated Idea or Task wake, Chorus attaches the anchor when the waker's corresponding Idea session is online. A Task wake first resolves its directly containing Idea, then finds the waker's session on that Idea. The receiving agent is told that replying on the current Idea or Task will return through the existing path to the waker's active session.

This is not a new forced-routing layer. If the waker is offline, has no session on the corresponding Idea, or the wake is not anchored to an Idea or Task, Chorus emits no anchor and keeps the existing notify-only behavior. The anchor only tells the receiving agent where this reply can land.

## Other changes in this release

Proposal reviewers, Task reviewers, and aggregate code review now include Intent Alignment. For work directly attached to an Idea, reviewers re-read the human-authored Idea, elaboration answers, and comments to detect scope creep, missing requirements, or an implementation that passes its acceptance criteria while missing the original goal.

Agent profiles can also store their own `args` and `env` in `~/.chorus/daemon.json`. `chorus agents run` and wakeable daemon backends can share the same model, reasoning, and provider configuration.

Leading flat frontmatter now renders as a metadata card. Tracker sidebar actions have moved into one Actions menu, with a bottom sheet on mobile.

## A smaller option alongside OpenSpec

spec-lite is not trying to replace OpenSpec. OpenSpec remains the default for changes that need a full change model, strict validation, and more involved specification management.

When a project only needs a small, readable local spec that lives in Git, Chorus now has that path built in. It keeps the essential spec and change record while continuing to use Chorus Proposals, Documents, Tasks, and reviewers for collaboration and verification.

---

## Upgrade

```bash
npm install -g @chorus-aidlc/chorus@0.18.0
chorus agents add
```

See [GitHub Release v0.18.0](https://github.com/Chorus-AIDLC/Chorus/releases/tag/v0.18.0) for the complete change list. Questions and feedback are welcome in [GitHub Issues](https://github.com/Chorus-AIDLC/Chorus/issues) or [Discussions](https://github.com/Chorus-AIDLC/Chorus/discussions).
