---
title: "Chorus v0.16.0: Let agents read the docs, not recall them"
description: "When a user asks an agent how Chorus works, is it reading today's docs or reciting what it saw in training?"
date: 2026-08-09
lang: en
postSlug: chorus-v0.16.0-release
---

# Chorus v0.16.0: Let agents read the docs, not recall them

Ask an agent how a Chorus feature works and it usually answers right away. But that answer comes from what the model saw during training, not from how the product behaves now. After a feature changes, a flow is reworked, or a parameter is renamed, an answer from memory drifts from reality, and the user can rarely tell the difference on the spot.

Chorus v0.16.0 connects the documentation site to the product and adds a `docs` skill that points agents at the current docs before they answer.

## A documentation site built for agents

The Chorus docs site is deployed at https://doc.chorus-ai.dev. Alongside the human-facing pages, it exposes two entry points that are easy for an agent to read:

- `/llms.txt` at the root is an index that lists every page with a one-line summary;
- append `.md` to any page URL to fetch that page as plain Markdown.

There is a single index, at the site root, and it is not localized. The pages themselves are available in multiple languages by path prefix.

## The docs skill

The new `docs` skill is a thin router. It does not cache any documentation. It defines an access convention instead:

1. read the `/llms.txt` index and pick the pages that match the question;
2. append `.md` to a page URL and fetch the raw Markdown;
3. answer from what was fetched, and link the human-readable page.

So the answer is grounded in the docs published right now, not in training memory. The skill hardcodes no page list; pages come and go through the index.

The skill ships to all six skill surfaces: Claude Code, Codex, OpenClaw, Kiro, Pi, and the standalone skill.

## For people too

The human path to the docs is filled in as well. All four READMEs (English, Chinese, Korean, Japanese) carry a documentation link in the header, and the landing page gains a Documentation entry in the top nav that points to the matching language.

## Summary

v0.16.0 is about one thing: when a user asks an agent how to use Chorus, the agent can now read the current docs before answering instead of reciting memory that may already be stale.

---

## Upgrade

```bash
npx @chorus-aidlc/chorus@0.16.0
```

After release, see the complete changes on [GitHub Releases](https://github.com/Chorus-AIDLC/Chorus/releases/tag/v0.16.0).

Questions or feedback? Open an issue on [GitHub Issues](https://github.com/Chorus-AIDLC/Chorus/issues) or start a thread in [Discussions](https://github.com/Chorus-AIDLC/Chorus/discussions).

---

**GitHub**: [Chorus-AIDLC/Chorus](https://github.com/Chorus-AIDLC/Chorus) | **Release**: [v0.16.0](https://github.com/Chorus-AIDLC/Chorus/releases/tag/v0.16.0)
