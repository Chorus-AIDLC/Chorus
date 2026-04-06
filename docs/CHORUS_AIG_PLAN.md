# Chorus AIG Implementation Plan

This document maps Linear's [Agent Interaction Guidelines (AIG)](https://linear.app/developers/aig) to Chorus and defines a phased plan for achieving comparable (and in some areas, superior) agent transparency and interaction quality.

Linear's AIG establishes six principles for agent behavior: **Agent Disclosure**, **Native Platform Integration**, **Instant Feedback**, **State Transparency**, **Respect for Disengagement**, and **Human Accountability**. Chorus already implements several of these through its MCP-based architecture, session system, and presence layer. This plan identifies what's done, what's in progress, and what's next.

## Current State: Feature Mapping

| Linear AIG Concept | Chorus Status | Notes |
|---|---|---|
| Agent Disclosure | **Done** | Agents are distinct entities with names, roles, robot icons, and deterministic colors. Never confused with human users. |
| Native Platform Integration | **Done** | Agents interact through the same MCP tools that define the platform's capabilities. No side channels. |
| Instant Feedback (Presence) | **Done** | Real-time presence indicators show which agents are viewing/mutating which entities. See [Presence Design](./PRESENCE_DESIGN.md). |
| Session Lifecycle | **Done** | AgentSession model with active/inactive/closed states, heartbeat, task checkin/checkout. |
| Activity Stream | **Done** | All agent actions logged with session attribution. Humans can inspect the full history. |
| Agent Plans (Progress Tracking) | **Partial** | Acceptance criteria on tasks serve a similar role but lack the structured plan/step model Linear provides. |
| Signals (Stop, Auth, Select) | **Not Started** | No equivalent to Linear's signal system for human-to-agent or agent-to-human structured messages. |
| Delegation Model | **Partial** | Polymorphic assignment supports human+agent collaboration, but no explicit "delegate" concept where the human stays primary. |
| Acknowledgment Timeout | **Not Started** | No enforcement that agents must respond within N seconds of assignment. |
| Conversation Reconstruction | **Partial** | Activity stream provides history, but no frozen activity snapshots independent of editable comments. |

## Phase 1: Presence (Done)

Real-time agent presence is the foundation of state transparency — the single most important AIG principle. It answers the immediate question: **"What is happening right now?"**

Chorus's presence system is fully implemented with automatic detection from MCP tool calls, SSE-based real-time delivery, and visual indicators across all entity types. For a complete technical description, see **[Presence Design](./PRESENCE_DESIGN.md)**.

Key capabilities:
- Zero-effort presence inferred from MCP tool parameters
- View vs. mutate action classification with distinct visual treatment
- Deterministic agent-color assignment for consistent visual tracking
- PixelCanvas visualization showing up to 7 active workers as animated sprites
- Multi-instance support via Redis Pub/Sub
- Ephemeral 3-second indicators with dual-layer throttling

## Phase 2: Structured Agent Status (Planning)

**Goal:** Move beyond presence (point-in-time activity) to continuous status communication — what the agent is doing, what it plans to do, and whether it needs help.

### 2a. Agent State Machine

Linear defines 6 session states: `pending`, `active`, `error`, `awaitingInput`, `complete`, `stale`. Chorus currently has 3: `active`, `inactive`, `closed`.

**Plan:** Extend the session status enum to include:
- **`thinking`** — Agent is reasoning or planning (maps to Linear's instant feedback requirement)
- **`blocked`** — Agent cannot proceed without human input or an external dependency
- **`error`** — Agent encountered a failure and needs attention

These states would be set via a new `chorus_session_set_status` MCP tool and displayed in the UI alongside presence indicators.

### 2b. Agent Plans

Linear's Agent Plans provide structured checklist-style progress within a session. Chorus's acceptance criteria partially fill this role, but they're tied to tasks, not sessions.

**Plan:** Add a lightweight `plan` JSON field to `AgentSession`:
```typescript
interface AgentPlan {
  steps: Array<{
    title: string;
    status: "pending" | "in_progress" | "completed" | "canceled";
    detail?: string;
  }>;
}
```

Agents update their plan via `chorus_session_update_plan`, and the frontend renders it as a collapsible checklist in the session detail view. This complements acceptance criteria (which define *what* needs to be done) with a plan (which shows *how* the agent is approaching it).

### 2c. Thinking Indicators

When an agent begins processing a task, it should emit an immediate "thinking" status (analogous to Linear's 10-second acknowledgment requirement). This could be:
- Automatic: The session transitions to `thinking` when a checkin occurs, with no explicit agent action needed.
- Visual: A pulsing indicator on the task card and in the PixelCanvas.

## Phase 3: Signals (Planning)

**Goal:** Enable structured, bidirectional communication between humans and agents beyond free-text comments.

### 3a. Human-to-Agent Signals

| Signal | Purpose | Trigger |
|--------|---------|---------|
| `stop` | Immediately halt the agent's current work | Button on task/session UI |
| `redirect` | Change the agent's focus or approach | Structured form |
| `approve` / `reject` | Respond to agent's proposed action | Inline approval widget |

Signals would be delivered as typed events through the existing SSE infrastructure and surfaced to agents via MCP tool polling (`chorus_get_signals`) or webhook push.

### 3b. Agent-to-Human Signals

| Signal | Purpose | Rendering |
|--------|---------|-----------|
| `elicitation` | Request human input with optional choices | Inline form with option buttons |
| `auth` | Request credential or permission | Auth link widget |
| `confirmation` | Ask before a high-impact action | Approve/deny dialog |

These map directly to Linear's `select` and `auth` signals. The rendering would use Chorus's existing comment system, extended with structured metadata.

### 3c. Implementation Approach

Signals can be modeled as a new entity type or as typed comments:

**Option A — Signal entity:** New `Signal` model with `type`, `direction`, `metadata`, `status` (pending/acknowledged/resolved). Clean separation but adds schema complexity.

**Option B — Typed comments:** Extend the existing `Comment` model with a `signalType` field and `signalMetadata` JSON. Lower friction, leverages existing notification and SSE infrastructure.

Leaning toward **Option B** for initial implementation, with the option to extract a dedicated model later if signal volume or complexity warrants it.

## Phase 4: Enhanced Accountability (Future)

**Goal:** Strengthen the connection between agent actions and human oversight.

### 4a. Delegation Model

Currently, tasks are assigned to either a human or an agent. Linear's model keeps the human as primary assignee and adds the agent as a "delegate." This makes accountability explicit.

**Plan:** Add an optional `delegatorUuid` + `delegatorType` to the Task model. When an agent is assigned a task that was previously owned by a human, the human becomes the delegator and retains oversight responsibility. The UI would show both: "Assigned to Agent X (delegated by Human Y)."

### 4b. Action Audit Trail

The activity stream already logs all actions, but it could be enhanced with:
- **Reasoning snapshots:** When an agent makes a decision (e.g., changing task status, modifying a document), it can attach a brief rationale.
- **Tool call detail:** Log the exact parameters of each MCP tool invocation, not just the high-level action.
- **Diff attribution:** For document changes, show what the agent changed, not just that it edited.

### 4c. Disengagement Protocol

Linear requires agents to stop immediately when signaled. Chorus should enforce:
- A `stop` signal that agents must acknowledge within 10 seconds.
- Automatic session closure if the agent fails to acknowledge.
- Clear visual feedback that the stop was received and work has ceased.

This depends on Phase 3 (Signals) being in place.

## Phase 5: External Integration (Future)

**Goal:** Connect agent activity in Chorus to external systems for end-to-end transparency.

### 5a. External URLs on Sessions

Linear sessions support `externalUrls` linking to PRs, dashboards, and other systems. Chorus sessions could add:
- **PR links:** Auto-detected from agent activity (e.g., `git push` in session logs)
- **CI/CD links:** Build and deployment status
- **Design tool links:** Figma/Pencil artifacts

### 5b. Webhook Push

Currently, agents poll for work via MCP tools. Adding outbound webhooks would enable:
- Instant notification when a task is assigned or a signal is sent
- Integration with external agent orchestrators
- Event-driven workflows without polling overhead

## Priority and Dependencies

```
Phase 1: Presence ──────────────────────── ✅ DONE
    │
Phase 2: Structured Status ──────────────── 🔲 PLANNING
    │   2a. Extended state machine
    │   2b. Agent plans
    │   2c. Thinking indicators
    │   2d. ✅ Unified Comment Component (agent delegation display, long comment collapse)
    │
Phase 3: Signals ────────────────────────── 🔲 PLANNING
    │   3a. Human → Agent (stop, redirect)
    │   3b. Agent → Human (elicitation, auth)
    │   3c. Implementation (typed comments)
    │
Phase 4: Enhanced Accountability ─────────── 🔲 FUTURE
    │   4a. Delegation model (runtime agent→owner resolution done in Phase 2d)
    │   4b. Action audit trail
    │   4c. Disengagement protocol (depends on Phase 3)
    │
Phase 5: External Integration ───────────── 🔲 FUTURE
        5a. External URLs
        5b. Webhook push
```

## Differences from Linear's Approach

Chorus and Linear serve different roles — Linear is a project management tool where agents are guests; Chorus is an AI-native collaboration platform where agents are first-class participants. This leads to some intentional divergences:

| Aspect | Linear AIG | Chorus Approach |
|--------|-----------|-----------------|
| **Presence detection** | Agents must explicitly emit activities | Automatic inference from MCP tool calls — zero agent effort |
| **Session model** | Tied to issues/comments | Independent entity supporting multi-task work and sub-agent spawning |
| **Activity types** | 5 fixed types (thought, action, response, elicitation, error) | Open activity stream with session attribution — more flexible but less structured |
| **Agent identity** | Application-level (one agent = one app) | Per-agent with roles (PM, Developer, Admin) within a single platform |
| **Billing** | Agents don't count as users | Agents are tracked entities with their own API keys and sessions |
| **Orchestration** | External (agent runs outside Linear) | Hybrid — agents can run externally via MCP or be orchestrated within Chorus sessions |

## References

- [Chorus Presence Design](./PRESENCE_DESIGN.md) — Technical deep-dive into the presence system (Phase 1)
- [Linear AIG Principles](https://linear.app/developers/aig) — Foundation principles
- [Linear Agent Interaction](https://linear.app/developers/agent-interaction) — Session, activity, and plan APIs
- [Linear Agent Signals](https://linear.app/developers/agent-signals) — Signal types and metadata
- [MCP Tools Reference](./MCP_TOOLS.md) — Chorus MCP tool documentation
