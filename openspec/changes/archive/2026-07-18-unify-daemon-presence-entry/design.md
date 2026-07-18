# Technical Design — Unify daemon presence into one bottom-right entry

## Overview

Merge two disjoint bottom-corner affordances into one. Today:

- **Bottom-left**: `AgentPresencePill` (`src/components/agent-presence-pill.tsx`) is
  docked at the bottom of the sidebar rail (mounted in `layout.tsx` inside
  `SidebarContent`, above the profile block). It reads the shell-level
  `useAgentPresence()` spine and, on click, opens a Popover roster whose footer
  "View all" button calls `setModalOpen(true)` to open the chat modal
  (`AgentConnectionsModal` → `DaemonChat`). Company-wide; on every dashboard page.
- **Bottom-right**: `PixelCanvasWidget` (`src/components/pixel-canvas-widget.tsx`) is
  a viewport-`fixed bottom-4 right-4` GIF button that opens a `Dialog` with the
  7-slot `PixelCanvas` "typing" visualization. It reads the **project-scoped**
  `RealtimeProvider` (via `useRealtimeEvent` + `getProjectActiveSessionsAction`) and
  is mounted in `layout.tsx` **only** inside the `isProjectContext` branch.

After: one floating button, bottom-right, on all dashboard pages, driven by the
shell-level `AgentPresenceProvider`. Click → slim roster popover with a prominent
open-chat action → chat modal. The pixel visualization survives as a secondary view,
offered only within a project context.

### Elaboration decisions driving this design (idea 404acfcf)

| Q | Decision |
|---|---|
| Entry location (q1) | **a** — take over the bottom-right floating position |
| One-click behavior (q2) | **b** — click opens a slim online roster with a prominent one-click "open chat" |
| Pixel widget fate (q3) | **c** — keep the pixel canvas as a *secondary* view reachable from the merged entry |
| Page scope (q4) | **a** — all dashboard pages (company-wide) |
| Glance indicator (q5) | **a** — keep an online-count badge / status dot on the button |

Edge case: the pixel secondary view is inherently project-scoped, so it is shown only
inside a project context; on global pages the entry offers roster + chat only. This
project-scoped handling was stated as the PM's default in the idea comment thread and
left open for the owner to override; elaboration was then resolved without an override.

## Architecture

### The data-spine mismatch (the core problem to solve)

The two affordances run on **different providers**, and this is the only real
obstacle to a naive merge:

- The pill/roster/chat run on `AgentPresenceProvider`
  (`src/contexts/agent-presence-context.tsx`) — mounted once at the shell wrapping
  the whole dashboard, **company-wide**, **survives navigation**, owns `modalOpen`,
  `openChatForAgent`, `openChatForSession`, `connections`, `onlineCount`,
  `executionsByConnection`.
- The pixel widget runs on `RealtimeProvider`
  (`src/contexts/realtime-context.tsx`) — mounted **per-`<main>`**, **scoped by
  `projectUuid`**, **remounts on navigation**, and is **absent on `/settings`**. The
  pixel widget calls `getProjectActiveSessionsAction(projectUuid)` and refreshes via
  `useRealtimeEvent`.

Resolution: the **merged button + roster + chat live on `AgentPresenceProvider`**
(so they are company-wide and present everywhere). The **pixel secondary view keeps
its `RealtimeProvider` dependency** and is therefore only rendered when a project
context is active. We do **not** try to lift the pixel's project-scoped session
source onto the shell provider — that would be a larger change with no user benefit
here (the pixel view is explicitly a secondary, project-flavored view).

### Component structure

Introduce one new component — the merged floating entry — and reduce the two
existing components to reusable pieces:

```
DaemonPresenceEntry (NEW, shell-level, fixed bottom-right, under AgentPresenceProvider)
├── Trigger button
│   ├── status dot (reuse PillDot state machine: loading | error | idle | online)
│   └── online-count badge  (q5=a)
└── Popover (side="top", align="end")  — click opens this (q2=b)
    ├── slim online-agent roster  (reuse PopoverBody / PopoverAgentGroup from the pill)
    ├── PROMINENT "Open chat" primary action → setModalOpen(true)   (q2=b)
    └── (project context only) "View activity" secondary link → opens pixel canvas   (q3=c, q4 edge)

AgentConnectionsModal + DaemonChat  — REUSED UNCHANGED (opened via setModalOpen)

PixelCanvasWidget  — REFACTORED: no longer renders its own fixed bottom-right button.
  Split into:
    - PixelCanvasView / PixelCanvasDialog (the Dialog + PixelCanvas body + its
      project-scoped data fetch), controlled by an `open` prop from the entry.
  Mounted only inside the project `RealtimeProvider` branch, its open-state lifted
  so the merged entry's "View activity" link can open it.
```

The roster popover body already exists in `agent-presence-pill.tsx` as
`PopoverBody` / `PopoverAgentGroup` / `PopoverInstanceRow` / `PopoverContentInner`.
The plan is to **extract that roster into a shared piece** the merged entry renders,
rather than re-implement it — preserving online-only filtering, per-agent collapse,
deterministic ordering, the running/queued execution rows, the Interrupt control,
and the 0-online `DaemonConnectCta` empty state.

### Mount / layout changes (`src/app/(dashboard)/layout.tsx`)

- **Remove** `<AgentPresencePill mobile={mobile} />` from `SidebarContent` (both
  desktop aside and mobile drawer paths use the same `SidebarContent`).
- **Remove** the `<PixelCanvasWidget .../>` standalone button from the
  `isProjectContext` `RealtimeProvider` branch.
- **Mount** `<DaemonPresenceEntry />` once under `AgentPresenceProvider` (alongside
  `AgentConnectionsModal`) so it is company-wide and appears on every dashboard page.
- **Bridge the pixel secondary view across the provider boundary.** The pixel view
  needs `RealtimeProvider` + `projectUuid`, but the merged entry lives above it on
  the shell provider. Approach: keep the pixel `Dialog` mounted inside the project
  `RealtimeProvider` branch (where `currentProjectUuid`/`projectName` and
  `useRealtimeEvent` are in scope), and lift its open-state to a small shell-level
  signal the entry can toggle. Options for that signal, to be chosen at build time
  and recorded in the spec's scenarios:
  1. a tiny dedicated context/provider at the shell exposing `pixelOpen` +
     `setPixelOpen` + `pixelAvailable` (set true only inside the project branch), or
  2. adding a `pixelOpen`/`setPixelOpen` pair onto `AgentPresenceProvider`.
  Either keeps the pixel's **data** on `RealtimeProvider` while letting the
  shell-level entry drive its open-state. The chosen mechanism MUST make the "View
  activity" affordance **absent** (not merely disabled) when no project context is
  active, so a global page shows roster + chat only.

### Mobile

Today the pill also renders in the mobile drawer (`SidebarContent mobile`). After the
merge there is no sidebar pill; the floating bottom-right entry is the mobile
affordance too. The button and popover must be reachable and not collide with other
fixed mobile chrome (the mobile top header is at `top-0`; the entry stays at
`bottom-4 right-4`). The chat modal is already mobile-fullscreen (`h-dvh w-screen`).

## Module Contracts

- **Open-chat contract**: the roster's prominent action calls
  `useAgentPresence().setModalOpen(true)`. To land the user directly on a specific
  agent's conversation, `openChatForAgent(agentUuid)` MAY be used (it seeds the chat
  focus target then opens the modal). The default action (no agent chosen) simply
  opens the chat modal — matching q2=b ("prominent one-click open chat").
- **Status-state contract**: the button's dot + count reuse the existing
  `(status, onlineCount)` → `loading | error | idle | online` derivation from the
  pill (`PillDot` + capsule skin). Error MUST NOT render as "0 online" (no silent
  error), idle stays visible at 0, reduced-motion degrades the pulse to a static dot.
- **Pixel-view availability contract**: the "View activity" affordance is present
  **iff** a project context is active (there is a `RealtimeProvider` + `projectUuid`);
  otherwise it is absent. When present, activating it opens the pixel `Dialog` with
  the current project's active-session slots.
- **Single-source contract**: the button, roster, and chat are all driven by the one
  shell-level `AgentPresenceProvider` — opening any of them MUST NOT start a second
  poll of the connection list.

## Implementation Plan

1. Extract the pill's roster popover body (`PopoverBody` and children) into a shared
   roster piece; build `DaemonPresenceEntry` (floating button + status dot +
   online-count badge + roster popover + prominent open-chat action). Remove
   `AgentPresencePill` usage from the sidebar.
2. Refactor `PixelCanvasWidget` so its canvas `Dialog` is a controlled secondary
   view (open-state lifted); wire the shell↔project open-state bridge; add the
   project-context-only "View activity" affordance to the entry. Re-mount everything
   in `layout.tsx`.
3. i18n (both locales) + light/dark theme verification + local e2e in a real browser.

## Risks & Mitigations

- **Provider-boundary bridge complexity** (shell entry ↔ project-scoped pixel view):
  mitigate by keeping the pixel *data* on `RealtimeProvider` and lifting only a small
  open-state signal; the "View activity" affordance is simply absent off-project.
- **Regression in the retired pill's behaviors** (online-only filter, per-agent
  collapse, deterministic order, Interrupt control, 0-online CTA): mitigate by
  *extracting and reusing* the existing roster body rather than rewriting it; the
  modified spec re-asserts these guarantees on the new surface.
- **Mobile discoverability** (pill was in the drawer; now it's a floating button):
  verify the floating entry is reachable and unobstructed on a narrow viewport.
- **Two themes**: the new button/popover use semantic tokens; verify light + dark
  before calling done (CLAUDE.md theme rule).

## Out of Scope

- Lifting the pixel-canvas active-session source onto the shell provider (so it could
  render globally / aggregate across projects). The pixel view stays project-scoped.
- Any change to the chat surface (`DaemonChat`), the presence/exec REST APIs, the SSE
  routes, MCP tools, the `DaemonConnection` schema, or migrations.
- `docs/design.pen` update — a human-only, out-of-band step (encrypted; Pencil MCP).
