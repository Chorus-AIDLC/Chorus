# Proposal: Daemon chat window vertical-space optimization

## Why

The daemon "conversation" window — the chat-style two-pane surface inside the agent-presence "View all" modal (`DaemonChat`) — wastes **vertical space**, most visibly on desktop. Three concrete complaints from use:

1. **Content does not top-align on desktop.** The right (transcript) pane's top edge sits well below the modal top. The outer container spends `lg:py-7` + `gap-6`, and a two-line `<header>` (title **plus** subtitle) eats height before any conversation shows. The transcript — the thing the user opened the window to read — starts too low.

2. **The header subtitle is redundant.** Once you are *inside* the conversation surface, the line "逐回合查看智能体做了什么。可在对话内继续发送或中断。" (`daemonChat.subtitle`) is stating the obvious. It is pure chrome competing with the conversation for vertical space.

3. **The standalone running-task card crowds the conversation.** After a send/dispatch, the footer stacks a standalone `ExecutionRow` card (running/interrupted state + Interrupt/Resume) **above** the reply box — two separate blocks, each taking a row, squeezing the transcript. The interrupt/resume/send actions are scattered instead of living together where the user's hands already are.

The fix is one theme: **let the conversation breathe vertically by cutting chrome** — drop the redundant subtitle, pull content to the top, and fold the Interrupt / Resume / Send actions into a single action row at the bottom-right of the input box, so the standalone task card disappears.

Two hard constraints (PM, non-negotiable):

- **Interrupt is destructive — it MUST keep its confirmation dialog** even after moving into the input action row, so a misclick never silently kills a running agent.
- **Running-state visibility MUST NOT be lost with the card.** "Which agent is running / how long it's been running" needs a new, lighter home — it cannot just vanish when the card does.

## What Changes

- **Remove the visible header subtitle.** Delete the visible `<p>{t("subtitle")}</p>` from `DaemonChat`'s header (desktop + mobile). The `daemonChat.subtitle` i18n **key is kept** — it is independently referenced by the hidden `DialogDescription` in `connections-modal.tsx` (the Radix Dialog accessibility "described-by"), which is a *separate* node from the visible subtitle and is **not** touched. So accessibility is unaffected; only the on-screen redundant line goes away.

- **Top-align the content.** Tighten the outer container's vertical padding and the header→body gap (`py-7`/`py-6`/`py-5` and `gap-6`) so the two-pane content sits close to the modal top, reclaiming the space the subtitle freed. The visible `<h2>` title is **kept** (it is the surface's heading); only its spacing and the now-single-line header shrink.

- **Move the running status into the transcript header (Q2=b).** The transcript header already shows a "running" pulse for the current turn; extend it to also carry the **elapsed run time** of this conversation's running execution. The standalone footer `ExecutionRow` card is then **removed** from the footer. The status carries **no** deep-link to the task/idea (Q3=b) — the header conversation title remains the jump-off point.

- **Consolidate Interrupt / Resume / Send into the input action row (Q1=b).** The reply composer (`ConversationReplyBox` / `ComposeField`) renders a single bottom-right action area:
  - **Send** is always present.
  - When this conversation has a **running** execution, **Interrupt** appears beside Send (keeping its `AlertDialog` confirmation).
  - When this conversation has a **user-interrupted** execution, **Resume** appears.
  - A **crash**-interrupted execution shows the existing "auto-recovers" hint (no Resume) — unchanged semantics.
  - **Input stays usable while running (send-while-running):** the textarea is NOT disabled during a running turn, so the user can type and send a follow-up/correcting instruction mid-run. This reuses the existing `POST /api/daemon-sessions/{uuid}/instruction` endpoint, which already appends a `human_instruction` turn regardless of run state — **no backend change**. (Origin-offline still hard-disables the composer with its visible read-only reason, unchanged.)

- **Apply to mobile too (Q4=a).** The mobile (`< lg`) drill-down footer gets the same treatment — standalone task card removed, actions folded into the input's action row — using the composer's existing `stacked` layout variant. Running status likewise reads from the transcript header.

- **i18n.** Any new user-facing string (e.g. an elapsed-time label in the header, if not already present) is added to **both** `messages/en.json` and `messages/zh.json`. No hardcoded text. The `daemonChat.subtitle` key is retained (still used for a11y).

- **design.pen.** Update the daemon chat window mock(s) to reflect: no visible subtitle, top-aligned content, header-carried running status, and the consolidated input action row (desktop + mobile).

## Capabilities

### Modified Capabilities

- `daemon-session-transcript-read`: The existing "Chat-style conversation surface" and mobile-fullscreen requirements describe the two-pane chat UI and an inline send/interrupt footer. This change adds three **refinement** requirements to the same capability: (1) minimized header chrome + top-aligned content, (2) running status carried in the transcript header instead of a standalone footer card, (3) Interrupt/Resume/Send consolidated into the reply input's action row with send-while-running. These are additive `## ADDED Requirements` — they refine, and do not contradict, the existing high-level surface requirement (which only states the right pane "SHALL offer inline send-instruction and interrupt controls," without dictating their layout).

## Impact

- **Schema**: none. No migration, no model change.
- **Backend code**: none. "Send while running" reuses the existing instruction endpoint as-is; running/interrupt/resume all reuse the existing `/api/daemon/control` + `/api/daemon/resume` + execution-snapshot machinery.
- **Frontend code**:
  - `src/components/agent-presence/chat/daemon-chat.tsx` — remove the visible subtitle `<p>`; tighten outer `py`/`gap` for top-align (desktop + mobile branches).
  - `src/components/agent-presence/chat/transcript-view.tsx` — header gains the running elapsed time; footer drops the standalone `ExecutionRow` list and instead feeds the running/interrupted execution into the composer's action row.
  - `src/components/agent-presence/send-instruction-box.tsx` — `ComposeField` / `ConversationReplyBox` grow an action-row API that hosts Send plus a state-driven Interrupt/Resume control; the textarea is no longer disabled merely because a turn is running.
  - `src/components/agent-presence/execution-row.tsx` — the `InterruptButton` (with its `AlertDialog`) and `ResumeButton` are extracted/reused as embeddable controls so the composer action row can render them byte-identically to today (same confirm dialog, same endpoints). The standalone `ExecutionRow` card itself remains available for other surfaces (popover/connection deck) — only the daemon-chat footer stops using it.
  - `messages/en.json` + `messages/zh.json` — any new key (elapsed-time label etc.); `daemonChat.subtitle` retained.
- **a11y**: the hidden `DialogDescription` in `connections-modal.tsx` is unchanged; removing the *visible* subtitle has no accessibility impact.
- **Docs**: `docs/design.pen` updated. No MCP tool change → `docs/MCP_TOOLS.md` and skill docs unchanged.
- **Runtime**: no new dependencies, no migration, no new permission bit.
- **Backward compat**: fully additive UI refinement. Interrupt keeps its confirmation; offline gating, crash auto-recovery, resume semantics, and the transcript/SSE pipeline are all unchanged. Other surfaces that render `ExecutionRow` (sidebar popover, connection deck) are not modified.

## Out of Scope

- Removing the visible `<h2>` header **title** — only the subtitle is redundant; the title stays.
- Any change to *when* a running agent consumes a mid-run instruction — that is daemon runtime behavior, out of this UI idea's scope. The UI only re-enables the composer; the existing turn pipeline handles the rest.
- Backend changes to the instruction / control / resume endpoints — all reused unchanged.
- Changing `ExecutionRow` usage on other surfaces (popover, Agent Connections deck) — they keep the standalone card.
- The connection-details collapsible disclosure (host/version/uptime) in the transcript header — unchanged.
