# Design: Requirements Elaboration (AI-DLC Stage 3)

> Date: 2026-02-24
> Status: Draft
> Related: [AIDLC_GAP_ANALYSIS.md](./AIDLC_GAP_ANALYSIS.md) — Gap #3 (Structured Inception Process)

## Problem

When a PM Agent claims an Idea and creates a Proposal, there is no structured process to ensure the requirements are fully understood. The current flow is:

```
Idea (free-form text) → PM reads it → PM creates Proposal with drafts → Admin approves/rejects
```

The PM Agent jumps from a vague Idea directly to a full Proposal. If the Idea is ambiguous, the PM either guesses (producing a flawed Proposal) or uses free-form comments to ask questions (unstructured, no validation, no gate).

AI-DLC requires a **mandatory clarification loop** between receiving requirements and producing artifacts:

```
Idea → PM analyzes → PM asks structured questions → Human answers →
  PM reviews answers →
    ├─ Gaps remain → PM opens another round (start_elaboration again) → Human answers → ...
    └─ Clear      → PM resolves elaboration (human-confirmed) → creates Proposal
```

> **Tool model.** Three tools drive the loop: `chorus_pm_start_elaboration` generates **any** round (first, follow-up, or a round appended after resolution); `chorus_answer_elaboration` records answers (its `roundUuid` is optional — it auto-locates the active round); and `chorus_pm_validate_elaboration` (gated `idea:admin`, human-confirmed except in YOLO) marks the whole elaboration complete. `chorus_pm_validate_elaboration` is Idea-level — it takes only `ideaUuid` and requires every round to be answered; opening a follow-up round is just another `start_elaboration` call. The round cap is **10**.

## Design Goals

1. **Structured Q&A** — Questions have typed options, not free-form chat
2. **Validation gate** — PM cannot proceed until all questions are answered and validated
3. **Iterative** — Multiple rounds of clarification are supported
4. **Observable** — Humans can see the full Q&A history on the Idea detail page
5. **Adaptive** — Simple Ideas can skip elaboration; complex Ideas get multiple rounds
6. **Builds on existing infra** — Reuses Chorus's existing patterns (polymorphic entities, MCP tools, Activity stream)

## Architecture Decision

### Option A: New `Elaboration` model (separate table)

A dedicated Prisma model for elaboration rounds with questions and answers.

**Pros**: Clean data model, proper relations, queryable.
**Cons**: New table, new CRUD, migration.

### Option B: JSON field on Idea (`elaborationRounds`)

Store Q&A rounds as a JSON array on the Idea model, similar to how Proposals store `documentDrafts` and `taskDrafts`.

**Pros**: Zero new tables, matches existing Proposal pattern (container with JSON drafts), faster to implement.
**Cons**: Not independently queryable, no referential integrity.

### Option C: Extend Comment model with `commentType`

Reuse Comments with structured types (question_set, answer_set).

**Pros**: Minimal schema change.
**Cons**: Overloads Comment semantics, awkward to query, doesn't enforce gate.

### Decision: **Option B** (JSON on Idea)

Reasoning:
- Follows the proven **container pattern** already used by Proposals (`documentDrafts`/`taskDrafts` are JSON arrays with UUIDs)
- Elaboration rounds are tightly coupled to the Idea lifecycle — they don't need independent existence
- Keeps the schema simple; we can migrate to Option A later if querying needs grow
- Fastest path to a working feature

## Data Model

### Schema Changes

```prisma
model Idea {
  // ... existing fields ...

  // New fields for elaboration
  elaborationDepth    String?   // "minimal" | "standard" | "comprehensive"
  elaborationRounds   Json?     // ElaborationRound[] — see structure below
  elaborationStatus   String?   // "pending_answers" | "validating" | "resolved"
}
```

### ElaborationRound JSON Structure

```typescript
interface ElaborationRound {
  uuid: string;              // Round identifier
  roundNumber: number;       // 1, 2, 3, ...
  createdAt: string;         // ISO 8601
  createdBy: {
    type: "agent" | "user";
    uuid: string;
  };

  // The questions
  questions: ElaborationQuestion[];

  // Round-level status. Active states are "pending_answers" → "answered".
  // ("validated" / "needs_followup" are legacy-only — resolution is an
  // Idea-level action, not a per-round one; they read the same as "answered".)
  status: "pending_answers" | "answered";

  // True when the round was created after the Idea was first resolved
  // (a pure supplement; keeps the Idea elaborated/resolved). See "Appended rounds".
  isAppended: boolean;
}

interface ElaborationQuestion {
  id: string;                // Question identifier (e.g., "q1", "q2")
  text: string;              // The question
  category: string;          // "functional" | "non_functional" | "business_context" |
                             // "technical_context" | "user_scenario" | "scope"
  options: QuestionOption[];  // 2-5 options
  required: boolean;

  // Filled by human
  answer?: {
    selectedOptionId: string | null;  // null if custom answer
    customText: string | null;        // For "Other" option or free-form
    answeredAt: string;
    answeredBy: {
      type: "user" | "agent";
      uuid: string;
    };
  };
}

interface QuestionOption {
  id: string;           // "a", "b", "c", "d", "e"
  label: string;        // Short label
  description?: string; // Longer explanation
}

// NOTE: there is no per-question issue tagging — `ValidationIssue` / round
// `validation` are not written. Opening a follow-up round is just another
// `chorus_pm_start_elaboration` call.
```

### Example Data

```json
{
  "elaborationDepth": "standard",
  "elaborationStatus": "pending_answers",
  "elaborationRounds": [
    {
      "uuid": "round-001",
      "roundNumber": 1,
      "createdAt": "2026-02-24T10:00:00Z",
      "createdBy": { "type": "agent", "uuid": "pm-agent-uuid" },
      "status": "pending_answers",
      "questions": [
        {
          "id": "q1",
          "text": "What is the expected scale of concurrent users for this feature?",
          "category": "non_functional",
          "required": true,
          "options": [
            { "id": "a", "label": "< 100", "description": "Internal team use only" },
            { "id": "b", "label": "100-1000", "description": "Department-level usage" },
            { "id": "c", "label": "1000-10000", "description": "Company-wide usage" },
            { "id": "d", "label": "> 10000", "description": "Public-facing, high traffic" },
            { "id": "e", "label": "Other" }
          ],
          "answer": null
        },
        {
          "id": "q2",
          "text": "Should this feature support offline mode?",
          "category": "functional",
          "required": true,
          "options": [
            { "id": "a", "label": "Yes, full offline", "description": "All features work without network" },
            { "id": "b", "label": "Yes, read-only offline", "description": "Can view but not modify" },
            { "id": "c", "label": "No", "description": "Requires constant network connection" },
            { "id": "d", "label": "Other" }
          ],
          "answer": null
        }
      ]
    }
  ]
}
```

### Appended rounds

Once an Idea's elaboration is resolved (`elaborationStatus = "resolved"`, Idea `elaborated`), a PM can still attach more clarification by calling `chorus_pm_start_elaboration` again. Such a round is flagged `isAppended = true` and is a **pure supplement**:

- The Idea **stays** `elaborated` and `elaborationStatus` **stays** `resolved`. Creating or answering an appended round never regresses the Idea back to `elaborating`/`validating`.
- Because the proposal-submission gate keys off `elaborationStatus === "resolved"`, an open appended round **never blocks** an in-flight Proposal.
- Re-resolving (`chorus_pm_validate_elaboration`) after answering an appended round is optional — it simply re-validates that round; the Idea was already resolved.
- The marker surfaces in `chorus_get_elaboration` (per-round `isAppended`) and in the elaboration UI as an "appended / follow-up" badge.

## Idea Status Flow (Simplified)

```
open → elaborating → proposal_created → completed
          │    ▲
          │    │ (follow-up round needed)
          ▼    │
     [PM asks questions — start_elaboration]
     [Human answers — answer_elaboration]
     [PM resolves — validate_elaboration, human-confirmed]
          │
          ▼
    [All resolved] → PM creates Proposal → proposal_created
```

Claiming an Idea automatically transitions it to **`elaborating`**. The simplified lifecycle removes `assigned`, `in_progress`, and `pending_review` in favor of a streamlined flow:

- **`open`** — Idea is available for claiming
- **`elaborating`** — PM has claimed the Idea and is clarifying requirements (auto-set on claim)
- **`proposal_created`** — Elaboration resolved, Proposal submitted
- **`completed`** — Proposal approved, tasks created
- **`closed`** — Admin closed the Idea

Status transitions:
```
open → elaborating           (PM claims the Idea — auto-transition)
elaborating → elaborating    (new round of questions)
elaborating → open           (PM releases the Idea)
elaborating → proposal_created (elaboration resolved, proposal submitted)
proposal_created → completed (proposal approved)
any → closed                 (admin closes)
```

## MCP Tools

### PM Agent Tools (new)

#### `chorus_pm_start_elaboration`

PM Agent analyzes the Idea and determines the appropriate depth. This is the single entry point for **every** round — the first round, any follow-up round, and rounds appended after the elaboration was already resolved.

```typescript
chorus_pm_start_elaboration({
  ideaUuid: string,
  depth: "minimal" | "standard" | "comprehensive",
  questions: [
    {
      id: string,          // "q1", "q2", ...
      text: string,
      category: string,    // functional, non_functional, business_context, ...
      required: boolean,
      options: [
        { id: "a", label: string, description?: string },
        // ... 2-5 options, last should be "Other"
      ]
    }
  ]
})
```

**Behavior**:
- Sets `elaborationDepth`, creates a new `ElaborationRound` in `elaborationRounds`
- **Normal round** (Idea `elaborating`): sets `elaborationStatus` to `"pending_answers"`, `isAppended = false`
- **Appended round** (Idea already `elaborated` / `elaborationStatus = "resolved"`): sets `isAppended = true`, leaves Idea status `"elaborated"` and `elaborationStatus = "resolved"` (a pure supplement — see "Appended rounds")
- Transitions Idea status to `"elaborating"` (only when not already `elaborated`)
- Creates Activity: `"elaboration_started"`
- Returns the created round UUID

**Validation**:
- Idea must be assigned to calling agent
- Idea must be in `elaborating` **or** `elaborated` status (the `elaborated` case produces an appended round)
- Round cap: at most **10** rounds per Idea
- At least 1 question required
- Each question must have 2-5 options

#### `chorus_pm_validate_elaboration`

PM Agent marks the whole elaboration complete (Idea-level — it does not target a single round): moves the Idea to `elaborated` and sets `elaborationStatus = resolved`. **Requires `idea:admin`** and **human confirmation before calling (except in YOLO mode).**

```typescript
chorus_pm_validate_elaboration({
  ideaUuid: string
})
```

**Behavior**:
- Idea status → `"elaborated"`, `elaborationStatus` → `"resolved"`. Round statuses are not modified.
- Creates Activity: `"elaboration_resolved"`
- Precondition: the Idea has at least one round and **every** round is answered (no round still in `pending_answers`). Fails otherwise.

**Permission / assignee notes**:
- Gated `idea:admin`. The `pm_agent` preset only grants `idea:write`, so a PM-preset agent must hand off to an `admin_agent`-preset agent (or admin key) to resolve.
- The resolving actor must also be the Idea's **assignee**. A separate human reviewer resolving a PM-owned Idea therefore needs **both** `idea:admin` and the Idea assignment.

> **Opening a follow-up round** no longer goes through a dedicated tool — just call `chorus_pm_start_elaboration` again (works while `elaborating`, or appended after `resolved`).

#### `chorus_pm_skip_elaboration`

For trivially clear Ideas (bug fixes, small changes), PM can skip the elaboration process.

```typescript
chorus_pm_skip_elaboration({
  ideaUuid: string,
  reason: string          // Why elaboration is unnecessary
})
```

**Behavior**:
- Sets `elaborationDepth` to `"minimal"`, `elaborationStatus` to `"resolved"`, `elaborationRounds` to `[]`
- Creates Activity: `"elaboration_skipped"` with reason
- Does NOT change Idea status (stays `in_progress`)

### Public Tools (Human/Admin answering)

#### `chorus_answer_elaboration`

Human (or Admin Agent) answers the pending questions.

```typescript
chorus_answer_elaboration({
  ideaUuid: string,
  roundUuid?: string,                  // Optional — auto-locates the active `pending_answers` round
  answers: [
    {
      questionId: string,
      selectedOptionId: string | null,  // null for custom answer
      customText: string | null         // Required if selectedOptionId is null or "Other"
    }
  ]
})
```

**Behavior**:
- `roundUuid` is **optional**: when omitted, the service auto-locates the Idea's single `pending_answers` round (errors if there are zero or more than one)
- Fills in `answer` on each question in the round
- If all required questions answered: marks round as `"answered"`; sets `elaborationStatus` to `"validating"` **unless** the Idea is already `resolved` (an appended round keeps `elaborationStatus = "resolved"` and never regresses the Idea — see "Appended rounds")
- Creates Activity: `"elaboration_answered"`
- Creates Notification to PM agent: "Elaboration answers received for Idea X"

**Validation**:
- All required questions must have answers
- `selectedOptionId` must match one of the question's option IDs (or null for custom)
- If `selectedOptionId` is the "Other" option, `customText` is required

> Each round object returned by `chorus_get_elaboration` includes an `isAppended` boolean so clients and the UI can render an "appended / follow-up" badge.

#### `chorus_get_elaboration`

Read the current elaboration state for an Idea.

```typescript
chorus_get_elaboration({
  ideaUuid: string
})
```

**Returns**:
```json
{
  "ideaUuid": "...",
  "depth": "standard",
  "status": "pending_answers",
  "rounds": [...],
  "summary": {
    "totalQuestions": 8,
    "answeredQuestions": 3,
    "validatedRounds": 1,
    "pendingRound": 2
  }
}
```

## Updated PM Workflow

The PM workflow (in `02-pm-workflow.md`) adds a new phase between Step 4 (Analyze) and Step 5 (Create Proposal):

```
### Step 4b: Requirements Elaboration

After analyzing the Idea, determine if clarification is needed:

**Simple Ideas** (bug fixes, small changes with clear requirements):
  → Skip elaboration:
  chorus_pm_skip_elaboration({ ideaUuid, reason: "Bug fix with clear reproduction steps" })

**Standard/Complex Ideas** (new features, multi-component changes):
  → Start elaboration:

  1. Determine depth based on Idea complexity:
     - "minimal": 2-4 questions, 1 round expected
     - "standard": 5-10 questions, 1-2 rounds expected
     - "comprehensive": 10+ questions, 2-3 rounds expected

  2. Create first round of questions:
     chorus_pm_start_elaboration({
       ideaUuid: "<idea-uuid>",
       depth: "standard",
       questions: [
         {
           id: "q1",
           text: "What user roles should have access to this feature?",
           category: "functional",
           required: true,
           options: [
             { id: "a", label: "All users" },
             { id: "b", label: "Admin only" },
             { id: "c", label: "Role-based (configurable)" },
             { id: "d", label: "Other" }
           ]
         },
         // ... more questions
       ]
     })

  3. Wait for answers (human fills in via UI or chorus_answer_elaboration tool).

  4. Review the answers:
     chorus_get_elaboration({ ideaUuid: "<idea-uuid>" })

     Check for:
     - Contradictions between answers (e.g., "offline mode" + "real-time sync")
     - Ambiguities (e.g., "Other" without clear explanation)
     - Missing context (required question unanswered)

  5. If gaps remain, open a follow-up round — just call start_elaboration again:
     chorus_pm_start_elaboration({
       ideaUuid: "<idea-uuid>",
       depth: "standard",
       questions: [ /* the follow-up questions */ ]
     })

  6. Repeat until you're satisfied the requirements are clear.

  7. When all clear — obtain human confirmation (skipped only in YOLO), then resolve:
     chorus_pm_validate_elaboration({
       ideaUuid: "<idea-uuid>"
       // roundUuid optional — defaults to the latest answered round
     })
     → Idea status becomes "elaborated", elaborationStatus becomes "resolved"
     → Proceed to create Proposal (Step 5)
     (Requires idea:admin — a pm_agent-preset key must hand off to an admin-preset agent.)
```

## Question Categories

The PM Agent should cover these categories (adapted from AI-DLC):

| Category | Description | Example Questions |
|----------|-------------|-------------------|
| `functional` | What the system should do | "Should users be able to export data?" |
| `non_functional` | Performance, scale, reliability | "What is the expected concurrent user count?" |
| `business_context` | Business goals, constraints, timeline | "Is this feature required for a specific launch date?" |
| `technical_context` | Tech stack, integration, migration | "Should this integrate with the existing auth system?" |
| `user_scenario` | User workflows, edge cases | "What happens when a user loses network mid-operation?" |
| `scope` | Boundaries, what's in/out | "Should mobile support be included in V1?" |

## Depth Guidelines

| Depth | When to Use | Expected Questions | Expected Rounds |
|-------|-------------|-------------------|-----------------|
| **Minimal** | Bug fixes, typos, config changes, clear one-liner requests | 0-3 | 0-1 |
| **Standard** | New features, UI changes, API additions with clear scope | 4-8 | 1-2 |
| **Comprehensive** | System migrations, architecture changes, multi-team features, vague/broad requests | 8-15 | 2-3 |

The PM Agent determines depth based on:
1. **Idea content clarity** — How specific is the request?
2. **Scope** — Single component vs system-wide?
3. **Risk** — Low-risk change vs production-critical?
4. **Existing context** — Are there existing docs/designs covering this area?

## Answer Channel Design

### Key Insight: PM Agent = The CC Session

A Chorus PM Agent is identified by an **API Key** with `pm_agent` role. When a human runs Claude Code with that API Key, the CC session **is** the PM Agent. The human and the PM Agent are in the **same terminal** — there is no sub-agent indirection.

This means: when the PM Agent needs to ask the human clarification questions, it can use `AskUserQuestion` **directly**. No SendMessage, no Team Lead proxy, no plugin hooks needed for the primary flow.

### Primary Flow: CC Terminal (Direct — Zero Infrastructure)

```
Human starts CC with PM Agent API Key
  │
  ▼
PM Agent claims Idea → analyzes → determines depth
  │
  ▼
PM Agent calls chorus_pm_start_elaboration()       ← persists to Chorus
  ├→ Stores questions in Idea.elaborationRounds
  ├→ Activity + Notification created (for UI/async channel)
  │
  ▼
PM Agent IMMEDIATELY uses AskUserQuestion:          ← asks human in terminal
  ┌────────────────────────────────────────────────────────┐
  │ Q1: What formats should the export support?            │
  │                                                        │
  │ ● CSV + JSON (Recommended)                             │
  │ ○ CSV only                                             │
  │ ○ CSV + JSON + XML                                     │
  │ ○ Other                                                │
  └────────────────────────────────────────────────────────┘
  │
  ▼
Human answers in terminal
  │
  ▼
PM Agent calls chorus_answer_elaboration()          ← persists answers
  │
  ▼
PM Agent reviews answers (check contradictions / gaps)
  ├─ All clear → resolve (human-confirmed) → proceed to Proposal
  └─ Gaps → start_elaboration again with follow-up questions → iterate
```

**No plugin hooks, no message relay, no proxy.** The PM skill doc simply instructs: "After calling `chorus_pm_start_elaboration`, immediately present the questions to the user via `AskUserQuestion`, then submit answers via `chorus_answer_elaboration`."

**Why persist to Chorus if PM asks directly?**
1. **Persistence** — If CC session dies mid-elaboration, the next session resumes (SessionStart detects `elaborationStatus = "pending_answers"`)
2. **UI access** — Human can review/amend answers on the Dashboard later
3. **Audit trail** — Full Q&A history for requirements traceability
4. **Multi-role** — If a different agent/user needs to answer (see secondary flow)

### Secondary Flow: Web UI (Async)

When the human is NOT in CC (offline, different timezone, or Idea created by someone else):

```
PM Agent creates questions → Chorus stores → Notification created
  │
  ▼
SSE pushes to browser → NotificationBell badge → Human clicks
  → Idea detail page → Elaboration panel → Radio buttons
  → Human answers → Server action calls elaborationService
  → Notification to PM Agent → PM resolves on next session
```

### Session Resume Flow

If the CC session restarts before elaboration is complete:

```
SessionStart hook → chorus_checkin() → assignments include:
  "Idea X: elaborationStatus = pending_answers"
  │
  ▼
PM Agent calls chorus_get_elaboration({ ideaUuid })
  ├─ Unanswered questions → AskUserQuestion (resume where left off)
  ├─ Answers exist, not resolved → resolve (human-confirmed) → proceed, or start_elaboration again for a follow-up
  └─ Elaboration resolved → proceed to Proposal creation
```

This requires no special hook logic — the PM skill doc instructs the agent to check elaboration status on assigned Ideas at session start.

### Both Channels, Same Backend

```
                    ┌──────────────────────────┐
  CC Terminal       │  elaborationService      │      Web UI
  (AskUserQuestion) │  .startElaboration()     │  (Radio button form)
        │           │  .answerElaboration()     │        │
        │           │  .resolveElaboration()    │        │
        ▼           │  .getElaboration()        │        ▼
  MCP Tool call ───▶│                          │◀─── Server Action
                    └──────────────────────────┘
                              │
                              ▼
                    Activity + Notification
                    (SSE to UI, MCP poll for agents)
```

### AskUserQuestion Compatibility

CC's `AskUserQuestion` tool supports:
- 1-4 questions per call, 2-4 options per question
- Each option has `label` + `description`
- User can always select "Other" for custom text
- Supports `multiSelect: true`

This maps well to elaboration questions. **Limitation**: max 4 questions × 4 options per call. If PM creates 8 questions, it presents them in 2 batches of `AskUserQuestion`. The PM skill doc should instruct: "If more than 4 questions, batch them into multiple AskUserQuestion calls."

### Why This Design Is Simple

| Aspect | Previous (wrong) model | Correct model |
|--------|----------------------|---------------|
| PM Agent is | A sub-agent of Team Lead | The CC session itself |
| Asks human via | SendMessage → Team Lead → AskUserQuestion | AskUserQuestion directly |
| Plugin hooks needed | TeammateIdle, UserPromptSubmit | None for primary flow |
| Infrastructure changes | New hook logic, message relay | Zero — skill doc only |
| Latency | PM → Team Lead → Human → Team Lead → PM | PM → Human → PM (instant) |

## Frontend Changes

### Idea Detail Page — Elaboration Panel

Add a new section to the Idea detail page (`src/app/(dashboard)/projects/[uuid]/ideas/[ideaUuid]/page.tsx`):

```
┌──────────────────────────────────────────────────────┐
│ Idea: Implement user export feature                  │
│ Status: elaborating    Depth: standard               │
├──────────────────────────────────────────────────────┤
│                                                      │
│ ┌─ Round 1 ─────────────────────── ✅ Validated ───┐ │
│ │                                                   │ │
│ │ Q1: What formats should be supported?             │ │
│ │ ○ CSV only                                        │ │
│ │ ● CSV + JSON            ← answered                │ │
│ │ ○ CSV + JSON + XML                                │ │
│ │ ○ Other                                           │ │
│ │                                                   │ │
│ │ Q2: Should export include soft-deleted records?   │ │
│ │ ● No, active records only    ← answered           │ │
│ │ ○ Yes, all records                                │ │
│ │ ○ Configurable per export                         │ │
│ │ ○ Other                                           │ │
│ │                                                   │ │
│ └───────────────────────────────────────────────────┘ │
│                                                      │
│ ┌─ Round 2 ─────────────────── ⏳ Pending answers ─┐ │
│ │                                                   │ │
│ │ Q3: You chose CSV + JSON. Should the JSON         │ │
│ │     format be flat or nested?                     │ │
│ │ ○ Flat (one level)                                │ │
│ │ ○ Nested (preserve relations)                     │ │
│ │ ○ Both (user chooses at export time)              │ │
│ │ ○ Other: [________________]                       │ │
│ │                                                   │ │
│ │              [ Submit Answers ]                    │ │
│ └───────────────────────────────────────────────────┘ │
│                                                      │
│ Comments (3)                                         │
│ ...                                                  │
└──────────────────────────────────────────────────────┘
```

### Key UI Elements

1. **Depth badge** — Shows "minimal" / "standard" / "comprehensive" next to Idea status
2. **Round cards** — Each round is a collapsible card with status indicator
3. **Question rendering** — Radio buttons for single-select, text field for "Other"
4. **Submit button** — Only enabled when all required questions are answered
5. **Validation indicators** — Show issues found by PM (contradictions, ambiguities)
6. **Timeline** — When each round was created, answered, validated

## Plugin & Notification Integration

### Primary Flow Needs No Plugin Changes

In the primary flow (human is in CC with PM Agent), the PM Agent uses `AskUserQuestion` directly. No plugin hooks, no notification polling, no message relay. The PM skill doc is the only "integration" needed.

### Notifications Serve the Secondary (UI) Flow

Chorus's existing notification system (EventBus + NotificationListener + SSE) handles the async/UI channel automatically:

1. `chorus_pm_start_elaboration()` → `activityService.createActivity({ action: "elaboration_started" })` → NotificationListener fires
2. Notification pushed to Idea creator via SSE → bell badge in browser
3. Human answers on Idea detail page → server action stores answers
4. Activity `elaboration_answered` → Notification to PM Agent
5. PM Agent picks up on next CC session via `chorus_get_elaboration`

### Notification Types to Add

Register in `notification-listener.ts`:

| Action | Trigger | Recipients | Preference Field |
|--------|---------|------------|------------------|
| `elaboration_started` | PM creates questions | Idea creator + project admins | `elaborationRequested` (new) |
| `elaboration_answered` | Human answers on UI | PM agent (Idea assignee) | `elaborationAnswered` (new) |
| `elaboration_followup` | PM creates follow-up round | Idea creator + project admins | `elaborationRequested` |
| `elaboration_resolved` | PM marks elaboration complete | Idea creator | `elaborationAnswered` |

Add to `NotificationPreference` model:
```prisma
elaborationRequested  Boolean @default(true)
elaborationAnswered   Boolean @default(true)
```

Note: In the primary CC flow, the PM Agent gets answers immediately (via `AskUserQuestion` return value), so `elaboration_answered` notifications are only useful for the async/UI flow where a different user answers on the dashboard.

### Session Resume (SessionStart Hook)

When a PM Agent's CC session restarts (crash, timeout, next day), the SessionStart hook already calls `chorus_checkin()` which returns assignments. The PM skill doc instructs the agent to check for Ideas with `elaborationStatus != "resolved"` and resume:

```
PM Agent starts session → chorus_checkin() → sees assigned Ideas
  → For each Idea with elaborationStatus = "pending_answers":
      → chorus_get_elaboration() → check if human answered on UI while PM was offline
        ├─ Answers present → resolve (human-confirmed) → proceed
        └─ No answers → AskUserQuestion again (resume in CC)
```

No plugin hook changes needed — this is purely skill doc instructions.

### End-to-End: CC Flow (Primary)

```
1. Human in CC (API Key has pm_agent role)
2. PM Agent (= CC session) claims Idea → analyzes
3. PM Agent calls chorus_pm_start_elaboration (stores to Chorus)
4. PM Agent IMMEDIATELY uses AskUserQuestion → human sees questions in terminal
5. Human answers in terminal
6. PM Agent calls chorus_answer_elaboration (persists answers)
7. PM Agent resolves (human-confirmed) → all clear → creates Proposal
```

Total round-trip: seconds. No async wait, no channel switching.

### End-to-End: UI Flow (Secondary)

```
1. Human creates Idea on Dashboard
2. A separate PM Agent session claims Idea, starts elaboration
3. PM Agent has no human in its CC terminal (batch/background mode)
   → PM calls chorus_pm_start_elaboration (stores questions)
   → PM goes idle / session ends
4. NotificationListener → SSE push → Dashboard bell badge
5. Human clicks notification → Idea detail page → answers in UI
6. NotificationListener → notification to PM Agent
7. PM Agent's next session: chorus_get_elaboration → sees answers → resolves (human-confirmed) → Proposal
```

Both flows use the same service layer. The difference is whether human interaction is synchronous (CC) or asynchronous (UI).

## Service Layer

### New file: `src/services/elaboration.service.ts`

```typescript
// Core functions
startElaboration(companyUuid, ideaUuid, actorUuid, depth, questions): ElaborationResponse  // any round; sets isAppended when Idea already resolved
answerElaboration(companyUuid, ideaUuid, actorUuid, actorType, answers, roundUuid?): ElaborationResponse  // roundUuid optional — auto-locates active round
resolveElaboration(companyUuid, ideaUuid, actorUuid, actorType): ElaborationResponse  // idea:admin; Idea-level resolve, requires every round answered
skipElaboration(companyUuid, ideaUuid, actorUuid, reason): ElaborationResponse
getElaboration(companyUuid, ideaUuid): ElaborationResponse

// Helpers
validateQuestionsFormat(questions): void  // Ensures 2-5 options, required fields, etc.
detectUnanswered(round): string[]         // Returns IDs of unanswered required questions
buildElaborationSummary(rounds): Summary  // Aggregates stats across rounds
```

### MCP Tool Registration

New tools registered in `src/mcp/tools/pm.ts` (PM-only):
- `chorus_pm_start_elaboration` (gated `idea:write`)
- `chorus_pm_validate_elaboration` (gated `idea:admin`; human-confirmed except in YOLO)
- `chorus_pm_skip_elaboration` (gated `idea:write`)

New tools registered in `src/mcp/tools/public.ts` (all roles):
- `chorus_answer_elaboration`
- `chorus_get_elaboration`

## Migration Path

### Phase 1: Core (MVP)

1. Add `elaborationDepth`, `elaborationRounds`, `elaborationStatus` to Idea model
2. Implement `elaboration.service.ts` with core functions
3. Register 5 new MCP tools
4. Add `elaborating` to Idea status transitions
5. Update PM workflow skill doc
6. Add i18n keys for elaboration UI

### Phase 2: Frontend

7. Build Elaboration panel on Idea detail page
8. Add answer submission form (radio buttons + text input)
9. Add round status indicators and validation issue display
10. Add depth badge to Idea cards

### Phase 3: Integration

11. Update Plugin context injection for elaboration-aware hints
12. Connect to Notification system (when available)
13. Add elaboration summary to `chorus_checkin` response

## Relationship to Proposal Flow

Elaboration does NOT replace the Proposal approval gate. It adds a **pre-Proposal** gate:

```
                  Elaboration Gate              Proposal Gate
                  (requirements clear?)         (plan acceptable?)
                        │                            │
Idea → PM claims → PM asks questions →    PM creates Proposal →    Admin approves
                   Human answers          with doc/task drafts      → Tasks created
                   PM validates           PM submits
                        │                            │
                  "Do we understand               "Is the plan
                   WHAT to build?"                 good enough?"
```

The two gates serve different purposes:
- **Elaboration gate**: Ensures requirements are understood before planning begins
- **Proposal gate**: Ensures the plan (PRD, tech design, task breakdown) is sound

## What This Does NOT Cover

- **Multi-stage gates within Proposal creation** — That's a separate enhancement (see Gap #5 in AIDLC_GAP_ANALYSIS.md)
- **Adaptive depth auto-detection** — PM Agent determines depth manually; auto-detection based on NLP analysis of Idea content is a future enhancement
- **Workspace Detection / Reverse Engineering** — These are IDE-level concerns, not platform-level. Chorus agents do this in their own environment.
- **Audit trail with raw user inputs** — The elaboration rounds implicitly record all Q&A with timestamps, which serves as a lightweight audit trail for requirements decisions
