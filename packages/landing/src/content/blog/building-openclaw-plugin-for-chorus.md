---
title: "Building an OpenClaw Plugin for Chorus"
description: "SSE + MCP dual-channel architecture to make AI agents truly live in the workflow — event push for awareness, tool protocol for execution."
date: 2025-03-02
lang: en
postSlug: building-openclaw-plugin-for-chorus
---

# Building an OpenClaw Plugin for Chorus: SSE + MCP to Make AI Agents Truly "Live" in the Workflow

Have you ever found yourself in this loop: task assigned on the platform, switch to terminal, copy-paste the description to the agent, wait for it to finish, go back to update status and @mention people. Every time. The agent is perfectly capable, but it can't sense "there's work incoming" and can't proactively report back — it's not a team member, just a tool you manually feed instructions to.

This article shares three patterns you can take away directly: **dual-channel architecture** (event push for awareness + tool protocol for execution), **prompt-driven behavior** (message templates guiding autonomous decisions), and **thin proxy bridging** (uniform pattern to expose MCP tools). Using the [Chorus](https://github.com/Chorus-AIDLC/chorus) × [OpenClaw](https://openclaw.ai) integration as a real-world example.

## TL;DR

1. **SSE + MCP as a natural pair** — Chorus's SSE event push (for humans) + MCP tools (for agents), and how they perfectly fit OpenClaw's plugin model
2. **OpenClaw's three plugin primitives** — `registerService` (background long-lived connections), `registerTool` (40 agent tools), `registerCommand` (slash commands) — and how they scaffold the entire integration
3. **Hooks-based wake mechanism** — From SSE event to `/hooks/wake` to the agent immediately starting work
4. **Message template design** — Using prompts to guide agent behavior (@mentions, tool calls, social etiquette) instead of hardcoding state machines
5. **registerTool bridging pattern** — How 40 MCP tools are exposed as native agent tools through a uniform pattern
6. **Gotchas** — npm scoped package names vs plugin IDs, defensive config handling, and other real-world issues

---

## 1. Background: Why This Plugin Exists

[Chorus](https://github.com/Chorus-AIDLC/chorus) implements the AI-DLC workflow:

```
Idea → Proposal → [Document + Task] → Execute → Verify → Done
 ^        ^            ^                 ^          ^        ^
Human   PM Agent    PM Agent         Dev Agent   Admin    Admin
```

[OpenClaw](https://openclaw.ai) is an AI Agent runtime with plugin support. Our goal: **assign work on Chorus, have the OpenClaw agent automatically detect, claim, execute, and report back**.

Without the plugin, the agent passively waits for terminal input. With it, the workflow becomes:

```
Human assigns task on Chorus UI
        ↓
SSE pushes task_assigned event
        ↓
Plugin auto-claims task
        ↓
Wakes agent to start work
        ↓
Agent @mentions the assigner when done
```

One click on the Web UI, everything else is automated.

---

## 2. SSE + MCP: Two Existing Paths That Fit Together

Chorus provides two interfaces for two types of users:

- **MCP tools** — The agent-facing API. 50+ tools covering the full AI-DLC workflow (claim task, create proposal, @mention, elaboration, etc.), authenticated via API Key (`cho_` prefix)
- **SSE event push** — The human-facing real-time notification stream (task assignments, proposal approvals, @mentions, etc.), consumed by the Web UI over a long-lived connection

For OpenClaw — an agent runtime where agents "work like humans" — these two paths combine naturally: **SSE to listen for events (know when to act), MCP to execute operations (know how to act)**.

```
Chorus Server
  │
  ├── SSE ──→ Plugin listens ──→ "Someone assigned you a task"
  │                                    │
  │                                    ▼
  │                               Wake agent
  │                                    │
  └── MCP ←── Agent calls ←── "chorus_claim_task + chorus_get_task + start working"
```

No custom API development needed. No changes to Chorus. When Chorus adds a new MCP tool, the plugin adds one line of registration and it just works.

### Reconnection

SSE connections drop due to network hiccups, server restarts, etc. Reconnection uses exponential backoff (1s → 2s → 4s → ... → 30s max). After a successful reconnect, the plugin calls `chorus_get_notifications` to backfill any missed notifications, ensuring zero event loss.

---

## 3. OpenClaw Plugin Mechanism: Three Primitives

To understand how this plugin works, you need to know what OpenClaw gives plugin authors. The plugin API has three core primitives:

| Primitive | Purpose | Role in This Plugin |
|-----------|---------|---------------------|
| `registerService` | Register a background service (with start/stop lifecycle) | **Maintain SSE long-lived connection** — starts on plugin load, continuously listens for Chorus events |
| `registerTool` | Register tools the agent can call | **Expose 40 Chorus MCP tools** — agent can claim tasks, create proposals, etc. |
| `registerCommand` | Register `/command` shortcuts (bypass LLM) | **`/chorus status`** and other quick-query commands |

The combination of these three primitives is the entire plugin skeleton:

```typescript
register(api) {
  // 1. Background service: SSE long-lived connection, listening for Chorus events
  api.registerService({
    id: "chorus-sse",
    async start() { /* establish SSE connection, events → eventRouter.dispatch() */ },
    async stop()  { /* disconnect SSE, close MCP client */ },
  });

  // 2. Tools: 40 Chorus operations exposed to the agent
  registerPmTools(api, mcpClient);      // 15 PM tools
  registerDevTools(api, mcpClient);     // 4 Developer tools
  registerCommonTools(api, mcpClient);  // 21 common tools

  // 3. Commands: /chorus status, /chorus tasks, /chorus ideas
  registerChorusCommands(api, mcpClient, getStatus);
}
```

### registerService: Maintaining the SSE Connection

This is the heart of the plugin. `registerService` allows a plugin to run a background process, independent of the agent's conversation loop. We use it to maintain the SSE connection to Chorus:

- `start()` is called on plugin load — establishes the SSE connection
- Automatic reconnection on disconnect (exponential backoff 1s → 30s max)
- Events are dispatched through the event-router
- `stop()` is called on plugin unload — graceful disconnect

SSE pushes minimal notification envelopes (`{ type: "new_notification", notificationUuid: "..." }`). The event-router fetches full details via MCP, then routes to the appropriate handler:

| Event | Agent Behavior |
|-------|---------------|
| `task_assigned` | Auto-claim task + wake agent to start work |
| `idea_claimed` | Wake agent to begin elaboration |
| `elaboration_requested` | Wake agent to review elaboration questions |
| `elaboration_answered` | Wake agent to review answers, @mention the answerer |
| `proposal_rejected` | Wake agent to fix proposal and resubmit |
| `proposal_approved` | Wake agent to check newly created tasks |
| `mentioned` | Wake agent to respond to @mention |

---

## 4. Waking the Agent: From Event to Action

The event-router knows what the agent "should do," but the agent might be idle. How do you make it **wake up immediately**?

Beyond plugin primitives, OpenClaw has a **Hooks system**. The key one is `/hooks/wake` — it allows external processes (like our SSE background service) to proactively wake the agent:

```typescript
await fetch(`${gatewayUrl}/hooks/wake`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${hooksToken}`,
  },
  body: JSON.stringify({
    text: "[Chorus] Task assigned: Implement auth module. Task UUID: xxx.",
    mode: "now",
  }),
});
```

This does two things:
1. Injects `text` as a system event into the agent's prompt — the agent sees it immediately
2. Triggers an immediate heartbeat — the agent wakes up right away, no polling delay

The `text` contains enough context (task UUID, project UUID, @mention format guidance) for the agent to start working immediately upon waking.

Note that hooks require a separate auth token (`hooks.token`) that must differ from the gateway's `auth.token` — this is an OpenClaw security design to prevent plugins and the gateway from sharing credentials.

---

## 5. Message Templates: Guiding Agent Behavior Through Prompts

The event-router's final output is a text string, injected into the agent's context via `/hooks/wake`. This string is the **message template** — it determines what the agent does after waking up.

This is an interesting pattern in OpenClaw plugin design: **the plugin doesn't control agent behavior; it guides the agent's autonomous decision-making through carefully crafted prompts**.

For example, the message template after elaboration answers are submitted:

```
[Chorus] Elaboration answers submitted for idea 'xxx'.
Review the answers with chorus_get_elaboration, then either:
- Call chorus_validate_elaboration with empty issues [] to resolve
- Call chorus_validate_elaboration with issues + followUpQuestions for another round

After reviewing, @mention the answerer to ask if they have
any further questions before you proceed.
Use this exact mention format: @[John](user:550e8400-...)
```

Notice the last two lines — we tell the agent through the prompt to "@mention the trigger person after completing work," rather than hardcoding @mention logic in code. Every event message the agent receives contains:

1. **Context**: Which entity, which project, UUIDs
2. **Tool guidance**: Which `registerTool`-registered tools to call
3. **Social behavior**: Who to @mention afterward, in what format

We initially tried hardcoding a state machine to enforce agent behavior (e.g., "must wait for human confirmation before validating"), but quickly realized it was over-engineering. **The agent has sufficient judgment on its own — the plugin just needs to provide the right context and tools, then guide direction through prompts.**

---

## 6. registerTool: Bridging 40 MCP Tools

`registerTool` is the second core primitive. It lets the plugin expose external capabilities as native agent tools — when the agent calls them, it feels like using a built-in tool, completely unaware of the MCP calls behind the scenes.

### The Bridging Pattern

Every OpenClaw tool is a thin proxy over a Chorus MCP tool. The pattern is highly uniform:

```typescript
api.registerTool({
  name: "chorus_claim_task",
  description: "Claim an open Task (open -> assigned)",
  parameters: {
    type: "object",                    // OpenClaw requires full JSON Schema
    properties: {
      taskUuid: { type: "string", description: "Task UUID" },
    },
    required: ["taskUuid"],
    additionalProperties: false,
  },
  async execute(_id: string, { taskUuid }: { taskUuid: string }) {
    // _id is OpenClaw's toolCallId; the second argument is the actual params
    const result = await mcpClient.callTool("chorus_claim_task", { taskUuid });
    return JSON.stringify(result, null, 2);
  },
});
```

Two OpenClaw-specific conventions worth noting:

- **`parameters` must be full JSON Schema** (`type: "object"` + `properties`), no shorthand — because OpenClaw interfaces with model providers like Bedrock that have strict schema format requirements
- **`execute`'s first argument is `toolCallId`**, not the tool parameters — this is OpenClaw's tool use protocol convention

### 40 Tools at a Glance

| Category | Count | Representative Tools |
|----------|-------|---------------------|
| PM Workflow | 15 | `chorus_claim_idea`, `chorus_create_proposal`, `chorus_pm_create_idea` |
| Developer Workflow | 4 | `chorus_claim_task`, `chorus_report_work`, `chorus_submit_for_verify` |
| Common & Exploration | 20 | `chorus_checkin`, `chorus_list_projects`, `chorus_search_mentionables` |
| Admin | 1 | `chorus_admin_create_project` |

---

## 7. Gotchas

### Gotcha 1: npm Scoped Package Name ≠ OpenClaw Plugin ID

This is the easiest trap to fall into. Our npm package name is `@chorus-aidlc/chorus-openclaw-plugin` (with org scope), but the OpenClaw plugin ID **must not include the scope prefix**.

Three places, three different naming rules:

| Location | Value | Notes |
|----------|-------|-------|
| `package.json` → `name` | `@chorus-aidlc/chorus-openclaw-plugin` | npm package name, with org scope |
| `openclaw.plugin.json` → `id` | `chorus-openclaw-plugin` | OpenClaw plugin ID, **no scope** |
| `src/index.ts` → `id` | `chorus-openclaw-plugin` | Must match the manifest |

When configuring `openclaw.json`, the `plugins.entries` key uses the plugin ID, not the npm package name:

```json
{
  "plugins": {
    "entries": {
      "chorus-openclaw-plugin": {
        "enabled": true,
        "config": { ... }
      }
    }
  }
}
```

If you use the npm package name (with `@scope/`) as the key, OpenClaw will report `plugin not found` or `plugin id mismatch`.

### Gotcha 2: hooks.token Must Differ from gateway.auth.token

OpenClaw's hooks auth token and gateway auth token must be different values. Using the same value triggers an error.

### Gotcha 3: Config Fields May Be undefined

OpenClaw may pass plugin config without running it through Zod validation. Even if your Zod schema has `.default([])`, the actual `projectUuids` may be `undefined`.

**Fix**: Defend all config fields with `?? []`, `?? true`, `?? ""`.

---

## 8. Project Structure

```
packages/openclaw-plugin/
├── package.json              # @chorus-aidlc/chorus-openclaw-plugin
├── openclaw.plugin.json      # OpenClaw plugin manifest (id: chorus-openclaw-plugin)
├── src/
│   ├── index.ts              # Plugin entry — wires all modules together
│   ├── config.ts             # Zod config schema
│   ├── mcp-client.ts         # MCP Client (lazy connect + 404 auto-reconnect)
│   ├── sse-listener.ts       # SSE long-lived connection + exponential backoff
│   ├── event-router.ts       # Event → agent action mapping
│   ├── commands.ts           # /chorus slash commands
│   └── tools/
│       ├── pm-tools.ts       # 15 PM workflow tools
│       ├── dev-tools.ts      # 4 Developer tools
│       └── common-tools.ts   # 20 common/exploration + 1 Admin tool
└── images/
    └── slug.png
```

### Installation

```bash
openclaw plugins install @chorus-aidlc/chorus-openclaw-plugin
```

Configure `~/.openclaw/openclaw.json`:

```json
{
  "hooks": {
    "enabled": true,
    "token": "your-hooks-token"
  },
  "plugins": {
    "enabled": true,
    "entries": {
      "chorus-openclaw-plugin": {
        "enabled": true,
        "config": {
          "chorusUrl": "https://chorus.example.com",
          "apiKey": "cho_your_api_key",
          "autoStart": true
        }
      }
    }
  }
}
```

---

## Closing Thoughts

The core idea behind this plugin can be summarized in one sentence: **make the agent a first-class citizen in the workflow, not a passive command executor**.

Through SSE for real-time event awareness, MCP tool bridging for operations, and @mention for closed-loop communication, the agent can participate in collaboration like a real team member — receiving assignments, reporting progress, requesting confirmation, responding to feedback.

Looking back, the most important discovery was that **Chorus's two existing interfaces — SSE for humans and MCP for agents — naturally fit the "real-time awareness + tool operations" plugin model**. No custom API development needed, no changes to Chorus. When Chorus adds a new MCP tool, the plugin adds one line of registration and it just works.

If your platform also serves both human users and AI agents, this "event push + tool protocol" dual-channel architecture is worth considering.

Project links:
- **Chorus**: [github.com/Chorus-AIDLC/chorus](https://github.com/Chorus-AIDLC/chorus)
- **OpenClaw Plugin**: [npm @chorus-aidlc/chorus-openclaw-plugin](https://www.npmjs.com/package/@chorus-aidlc/chorus-openclaw-plugin)
