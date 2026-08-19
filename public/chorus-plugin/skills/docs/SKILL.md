---
name: docs
description: Chorus documentation router — consult the live Chorus docs site to answer product-usage questions (UI workflow, agent/plugin setup, API/MCP, deployment, operations).
license: AGPL-3.0
metadata:
  author: chorus
  version: "0.16.4"
  category: project-management
  mcp_server: chorus
---

# Docs Skill

This skill is a **thin router to the live Chorus documentation site** (`https://doc.chorus-ai.dev`). Use it to answer questions about **how to use, configure, deploy, or operate Chorus** — grounding the answer in the current published docs instead of memory.

It is **not** a workflow skill: it does not drive the AI-DLC pipeline. For that, use `/idea`, `/proposal`, `/develop`, `/review`, or `/yolo`.

---

## When to Use

Use this skill whenever the user asks a **product-usage** question about Chorus, such as:

- **UI workflow** — how the Idea → Proposal → Task → Verify pipeline works in the web app, what a control does, how statuses flow.
- **Agent setup** — creating an API key, permissions and role presets, connecting an agent.
- **Plugin setup** — installing/configuring the Claude Code / Codex / OpenClaw / Kiro / Pi plugin.
- **API / MCP** — the REST API, the MCP tool surface, authentication, real-time events.
- **Deployment** — self-hosting, the CDK stack, environment configuration.
- **Operations / troubleshooting** — running Chorus, diagnosing connection or setup problems.

Do **NOT** use it to *drive* the pipeline (claiming ideas, writing proposals, executing tasks) — that is what the stage skills above are for. This skill answers "how does the product work / how do I set it up"; the stage skills *do* the work.

---

## Access Convention

The docs site is agent-friendly. Follow this three-step convention every time. **Do NOT** answer from memory, and **do NOT** hardcode a page list — the index is the source of truth and pages change over time.

1. **Fetch the index.** Get `https://doc.chorus-ai.dev/llms.txt` — a machine-readable index that lists every documentation page with a one-line summary and its `.md` URL. **The index is a single, unlocalized file that lives ONLY at the root `/llms.txt`. Never prefix it with a locale — `https://doc.chorus-ai.dev/zh/llms.txt` (and `/ja/`, `/ko/`) does NOT exist and returns 404.**
2. **Fetch the relevant page(s) as raw Markdown.** Pick the page(s) that match the question from the index, then fetch the raw Markdown by **appending `.md`** to the page URL (e.g. `https://doc.chorus-ai.dev/guides/getting-started` → `https://doc.chorus-ai.dev/guides/getting-started.md`).
3. **Ground the answer and link the human page.** Base your answer on the fetched Markdown, and link the human-facing page (the `.md` URL **without** the `.md` suffix) so the user can open it in a browser.

Use whatever web-fetch capability your environment provides (your built-in fetch tool, `curl`, etc.) — this skill states the convention, not a specific tool binding.

---

## Locale

The `/llms.txt` index itself is **not** localized — there is exactly one, at the root. Localization applies to **pages**, not the index:

- The index always lives at `https://doc.chorus-ai.dev/llms.txt` and lists the root (`en`) page URLs. **Do not look for `/zh/llms.txt` — it does not exist.**
- `en` is the root (unprefixed): `https://doc.chorus-ai.dev/...`
- `zh`, `ja`, `ko` are **path-prefixed pages**: take a page path from the index and prepend the locale — `https://doc.chorus-ai.dev/zh/...`, `/ja/...`, `/ko/...`
- Appending `.md` works on the prefixed pages too (e.g. `https://doc.chorus-ai.dev/zh/guides/getting-started.md`).
- **Match the user's language** when the docs exist in it; fall back to `en` otherwise.

---

## Relationship to the Workflow Skills

This skill **complements** the AI-DLC workflow skills — it does not replace them:

| The user wants to… | Use |
|--------------------|-----|
| Learn how to use / configure / deploy / operate Chorus | **this skill** (`/docs`) |
| Drive an idea / write a proposal / execute or verify a task | `/idea`, `/proposal`, `/develop`, `/review`, `/yolo` |

Always use the live host `doc.chorus-ai.dev`. `docs.chorus-ai.dev` (with an "s") is a dead link — never use it.
