<p align="center">
  <img src="packages/landing/public/images/chorus-slug.png" alt="Chorus" width="240" />
</p>

<p align="center"><strong>The harness for your coding agents. Agents propose, humans verify, software ships.</strong></p>

<p align="center">
  <a href="https://discord.gg/SwcCMaMmR">
    <img src="https://img.shields.io/badge/Discord-Join%20us-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord">
  </a>
  <a href="https://github.com/Chorus-AIDLC/Chorus/actions/workflows/test.yml">
    <img src="https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/ChenNima/f245ebf1cf02d5f6e3df389f836a072a/raw/coverage-badge.json" alt="Coverage">
  </a>
</p>

<p align="center"><strong>English</strong> · <a href="README.zh.md">中文</a> · <a href="README.ko.md">한국어</a> · <a href="README.ja.md">日本語</a></p>

<p align="center"><a href="https://doc.chorus-ai.dev"><strong>📖 Documentation</strong></a></p>

Chorus is the harness for your coding agents. A coding agent harnesses a model to write code; Chorus is the harness one level up, taking a whole team of those agents, plus you, into a single pipeline where agents propose, humans verify, and ideas turn into delivered software. Underneath, it handles what holds multi-agent, human-in-the-loop work together: session lifecycle, task state, sub-agent orchestration, observability, and failure recovery. Every AI Agent gets fine-grained, configurable permissions.

Inspired by the **[AI-DLC (AI-Driven Development Lifecycle)](https://aws.amazon.com/blogs/devops/ai-driven-development-life-cycle/)** methodology. Core philosophy: **Reversed Conversation** — AI proposes, humans verify.

---

## AI-DLC Workflow

```
Idea ──> Proposal ──> [Document + Task DAG] ──> Execute ──> Verify ──> Done
  ^          ^               ^                     ^          ^         ^
Human     idea:write     proposal:write         task:write   *:admin    *:admin
creates   + elaborate    + drafts                + reports   + verifies + closes
```

The labels under each stage are the **permissions** an actor needs there — granted to a human, an Agent, or both. There are no fixed roles; any combination of the 5 × 3 permission matrix works. → [Agent permissions](https://doc.chorus-ai.dev/guides/manage-agents/)

---

## What's New

**[v0.16.4](https://chorus-ai.dev/blog/chorus-v0.16.4-release/)** — DeepSeek Harness (dsh) is the sixth way to connect: the `@chorus-aidlc/chorus-dsh` bundle drops Chorus's skills, persona, and MCP config into any dsh profile. Interactive for now; daemon wake comes later.

**[v0.16.1](https://chorus-ai.dev/blog/chorus-v0.16.1-release/)** — One `chorus daemon` now serves many independent agents at once — each with its own key, working directories, backend, and permissions via an `agents[]` array — and agents can hand work to each other by @-mention, with each wake landing in that agent's own project directory.

**[v0.16.0](https://chorus-ai.dev/blog/chorus-v0.16.0-release/)** — A `docs` skill that points agents at the live docs site ([doc.chorus-ai.dev](https://doc.chorus-ai.dev)), so they answer from the current docs instead of reciting from memory.

**[v0.15.0](https://chorus-ai.dev/blog/chorus-v0.15.0-release/)** — Project-level Agent working directories: each user can bind every Agent in a project to a host and cwd, browse only daemon-approved roots, and use the same target across assignment, wake, resume, and later turns without moving active sessions. Codex now persists its resumable backend thread ID separately and drops obsolete Chorus session-management steps.

**[v0.14.1](https://chorus-ai.dev/blog/chorus-v0.14.1-release/)** — Amazon Kiro CLI is the fourth way to connect (Kiro CLI v2): a one-command Kiro plugin via `chorus agents add` and a `--agent kiro` daemon backend, plus daemon fixes.

**[v0.14.0](https://chorus-ai.dev/blog/chorus-v0.14.0-release/)** — Dark mode across the app (light / dark / system). Reference artifacts: attach docs, repos, issues, and articles to any idea, proposal, or task, readable inline and over MCP. Korean and Japanese locales (Korean contributed by the community). **Theme** ideas for grouping, plus daemon Start Development / Yolo buttons, conversational idea entry, crash-resume, and `chorus daemon install`.

> Full changelog: [CHANGELOG.md](CHANGELOG.md)

---

## Quick Start

Two commands. No database, no Docker, no config files.

```bash
npm install -g @chorus-aidlc/chorus@0.17.0
chorus
```

Chorus starts with an embedded PostgreSQL (PGlite), runs migrations, and opens at **http://localhost:8637**. Default login: `admin@chorus.local` / `chorus`.

> Running multiple agents or deploying to production? Use an external PostgreSQL, Docker, or AWS → **[Deploy & self-host](https://doc.chorus-ai.dev/guides/deployment-overview/)**.

To turn your local machine into an agent runtime that picks up assigned tasks, run `chorus daemon` → **[Daemon operations](https://doc.chorus-ai.dev/guides/daemon-operations/)** · **[Remote control](https://doc.chorus-ai.dev/guides/remote-control/)**.

---

## See It in Action

### Remote Agent Wake — dispatch to a directory, watch it run

![Remote Agent Wake](packages/landing/public/images/agent-daemon-wake.gif)

Assign an idea to a directory on a remote agent, then open the conversation and watch the local Claude Code pick up the work and run in real time — no terminal, no manual resume.

### Project Resource Graph — the whole project as a live mind-map

![Project Resource Graph](packages/landing/public/images/mind-map.png)

Ideas, Proposals, Documents, and Tasks laid out as one connected tree, with each card's status updating live as the agents work.

### Proposal — AI generates plans in real time

![Proposal Presence](packages/landing/public/images/proposal-presence.gif)

A PM Agent analyzes requirements and generates a PRD plus a task DAG, with live presence indicators showing agent activity.

### Kanban — real-time task flow

![Kanban Presence](packages/landing/public/images/kanban-presence.gif)

Task cards flow between To Do → In Progress → To Verify as agents work, with presence indicators on whatever is being touched.

---

## Connect an Agent

The fastest path is the in-app wizard: open **Settings → Setup Guide**. It creates the API key and shows the exact commands for your client — Claude Code, Codex, Kiro, dsh, OpenCode, OpenClaw, Pi, or any MCP-compatible agent.

Full per-client guides → **[Agent platforms](https://doc.chorus-ai.dev/reference/agents/)**.

API keys are created under **Settings → Agents → Create API Key**. They start with `cho_` and are shown only once.

---

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Framework | Next.js 15 (App Router, Turbopack) |
| Language | TypeScript 5 (strict mode) |
| Frontend | React 19, Tailwind CSS 4, shadcn/ui |
| Data | PostgreSQL 16 + Prisma 7, Redis 7 (optional) |
| Agent Integration | MCP SDK (HTTP Streamable Transport) |
| Auth | OIDC + PKCE / API Key / SuperAdmin |
| i18n | next-intl (en, zh, ko, ja) |
| Deployment | npm / Docker / AWS CDK |

---

## Documentation

**📖 Full documentation: [doc.chorus-ai.dev](https://doc.chorus-ai.dev)**

- [Getting started](https://doc.chorus-ai.dev/guides/getting-started/)
- [Connect an agent](https://doc.chorus-ai.dev/reference/agents/)
- [The AI-DLC workflow](https://doc.chorus-ai.dev/guides/ai-dlc-workflow/)
- [Plugins & commands](https://doc.chorus-ai.dev/guides/plugin-commands/)
- [MCP tools reference](https://doc.chorus-ai.dev/reference/mcp-tools/)
- [Deploy & self-host](https://doc.chorus-ai.dev/guides/deployment-overview/)

---

## License

AGPL-3.0 — see [LICENSE.txt](LICENSE.txt)
