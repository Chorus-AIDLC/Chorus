---
title: "Chorus v0.6.6: One npx, Zero Setup"
description: "No Docker, no database, no config files. Just npx and a browser. Plus: export your docs."
date: 2026-04-23
lang: en
postSlug: chorus-v0.6.6-release
---

# Chorus v0.6.6: One npx, Zero Setup

[Chorus](https://github.com/Chorus-AIDLC/Chorus) v0.6.6 is out. Two things in this release: npm install that actually works everywhere, and document export so your content isn't trapped inside Chorus.

---

## How many people did the install scare off?

You tell a colleague about Chorus. They say "sure, I'll try it." Then you start explaining: install Docker, pull the image, set up compose, configure environment variables...

They haven't opened a terminal yet, and you've already lost half their interest.

v0.6.2 added PGlite as an embedded database and swapped Redis for an in-memory event bus with automatic fallback. Three containers down to one. But "install Docker" was still a prerequisite. For someone who just wants a quick look at what Chorus does, Docker itself is the barrier.

---

## Now npx is all you need

```bash
npx @chorus-aidlc/chorus
```

No Docker. No database config. No docker-compose.yml. npx pulls the package, PGlite runs PostgreSQL in-process, migrations run automatically. Open a browser and you're in. 

This works because Chorus runs entirely on WASM and pure JS with zero native C/C++ dependencies. macOS ARM, Linux x86/ARM — npx just works, no build toolchain needed.

For production, Docker Compose with standalone PostgreSQL + Redis is still the recommended setup, especially for multi-agent concurrency. But "just trying it out" shouldn't require any prerequisites.

---

## Community ask: get your docs out

In [Issue #195](https://github.com/Chorus-AIDLC/Chorus/issues/195#issuecomment-4286676685), @songyitao1991 raised a practical point:

> Project delivery always involves client sign-off. You need milestone PRDs and technical docs. Chorus is great for AI-driven development, but it can't produce the traditional deliverables clients expect for review and approval.

Fair point. If AI-generated documents can only be viewed inside Chorus, they're intermediate artifacts in a closed system, not deliverable assets.

v0.6.6 adds document export in three formats:

- **Markdown**: with YAML frontmatter, ready to drop into any docs platform
- **PDF**: bundled CJK + emoji fonts, Mermaid diagrams rendered as PNG, works out of the box
- **Word**: syntax-highlighted code blocks, for people who prefer Word over Markdown

Export is available on document detail pages, document list pages, and the proposal editor. Draft documents inside proposals can be exported before approval — no need to wait for sign-off to get the content out.

---

## Other changes

- **Proposal revoke**: Approved proposals can now be revoked. Code going sideways? Revoke the proposal, fix it, resubmit. Revoke cascade-closes materialized tasks and deletes generated documents, resetting to draft. An impact preview dialog prevents accidental triggers.
- **Checkin API overhaul**: Agents get the full picture in one call — project-grouped idea tracker, unread notification summary, ready to pick up where they left off.
- **Onboarding improvements**: Back navigation across the Copy Key / Install Plugin / Test Connection steps. No more 5-minute timeout waiting for agent connection — SSE listens indefinitely. A copyable checkin prompt on the waiting screen means new users don't have to dig through docs.
- **Auto review reminder**: Sub-agents now get a review + verify reminder after task completion. No more manual nudging to submit for verification.

---

## Upgrade

npm users:
```bash
npx @chorus-aidlc/chorus@latest
# or install globally
npm install -g @chorus-aidlc/chorus
```

Docker users:
```bash
docker compose up -d --pull always
```

Don't forget to update the Chorus Plugin — the new onboarding flow and review reminders depend on it:

```bash
# Inside Claude Code
/plugin marketplace update chorus-plugins
```

v0.6.6 is on [GitHub Releases](https://github.com/Chorus-AIDLC/Chorus/releases/tag/v0.6.6) and [npm](https://www.npmjs.com/package/@chorus-aidlc/chorus).

Questions or feedback? [GitHub Issues](https://github.com/Chorus-AIDLC/Chorus/issues) or [Discussions](https://github.com/Chorus-AIDLC/Chorus/discussions).

---

**GitHub**: [Chorus-AIDLC/Chorus](https://github.com/Chorus-AIDLC/Chorus) | **Release**: [v0.6.6](https://github.com/Chorus-AIDLC/Chorus/releases/tag/v0.6.6)
