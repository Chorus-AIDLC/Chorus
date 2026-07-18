## Why

Opening a conversation with an online daemon agent today is a three-step drill-down:
the user must find the presence **pill** docked at the bottom of the left sidebar,
click it to open a roster popover, then click **"View all"** to finally reach the
chat modal. The entry is neither obvious nor direct. Separately, a second floating
affordance — the **pixel-canvas widget** — sits in the bottom-right corner showing a
playful 7-slot "typing" animation of the current project's active sessions. Two
disjoint bottom-corner affordances, both ultimately *about online daemon agents*,
read as visually and mentally fragmented.

This change merges them into **one** bottom-right floating entry so that "see who's
online → open a conversation" is a two-step, one-obvious-place interaction.

## What Changes

- **New single entry point, bottom-right, all dashboard pages.** A floating button
  (taking over the current pixel-widget corner) becomes the single affordance for
  daemon presence + conversation. It is driven by the shell-level
  `AgentPresenceProvider`, so it is company-wide and survives navigation — present
  on every dashboard page, unlike the project-scoped pixel widget today.
- **One click → slim online roster with a prominent "open chat" action.** Clicking
  the button opens a compact popover listing online agents (glanceable), with a
  visually prominent one-click affordance that opens the daemon chat modal directly.
  This collapses today's `pill → roster popover → "View all" → modal` chain to
  `button → roster → chat`.
- **Retire the sidebar presence pill.** The bottom-of-sidebar `AgentPresencePill`
  is removed; its resident online-count + status information is preserved on the new
  floating button (an online-count badge / status dot).
- **Pixel-canvas visualization kept as a secondary view.** The pixel "typing"
  animation is not deleted — it becomes a secondary, reachable-on-demand view from
  the merged entry. Because it is inherently project-scoped (it reads the current
  project's active sessions via the per-project `RealtimeProvider`), the secondary
  view is offered **only within a project context**; on global pages (`/projects`,
  `/project-groups`, `/settings`) the entry offers roster + chat only, with no pixel
  view. (This project-scoped handling was stated as the PM's default in the idea
  comment thread and left open for the owner to override; elaboration was then
  resolved without an override.)
- **No backend / data-model change.** This is a frontend interaction-layer refactor
  over the existing presence spine, `GET /api/agent-connections`,
  `GET /api/daemon/executions`, the daemon-session chat APIs, and the existing pixel
  active-sessions action. No new API, permission bit, schema, or migration.

## Capabilities

### New Capabilities
_(none)_

### Modified Capabilities
- `agent-connection-observability`: The requirement "The dashboard SHALL surface
  daemon connections through a resident sidebar presence indicator, a popover, and a
  modal" is replaced by a requirement that surfaces them through a **single
  bottom-right floating entry** (button + roster popover with a direct open-chat
  action + chat modal), removing the sidebar pill and folding the pixel-canvas view
  in as a project-scoped secondary view. Shared-single-source, three-state
  (idle/loading/error), reduced-motion, deterministic-order, and read-only
  guarantees are preserved on the new surface.

## Impact

- **UI components**: `src/components/agent-presence-pill.tsx` (pill removed; its
  popover roster body is reworked into the floating-entry popover with a prominent
  open-chat action), `src/components/pixel-canvas-widget.tsx` (no longer a
  standalone bottom-right button; its canvas becomes a secondary view reachable from
  the merged entry), a new merged floating-entry component, and
  `src/app/(dashboard)/layout.tsx` (mount/position: remove the sidebar pill + the
  RealtimeProvider-nested pixel widget; mount the merged entry once at the shell
  under `AgentPresenceProvider`).
- **Data spine**: reuses the shell-level `AgentPresenceProvider` (`modalOpen`,
  `openChatForAgent`/`openChatForSession`, connections, executions). The pixel
  secondary view continues to read the project-scoped active-sessions action and
  therefore renders only inside a project's `RealtimeProvider`.
- **Chat modal**: `src/components/agent-presence/connections-modal.tsx` +
  `chat/daemon-chat.tsx` are reused unchanged as the chat surface the merged entry
  opens.
- **i18n**: new/repositioned strings (button aria-label, roster header, open-chat
  action label, secondary-view label) added to both `en` and `zh`.
- **Themes**: the new floating button + popover must be verified in light and dark.
- **No change** to REST APIs, MCP tools, Prisma schema, migrations, or SSE routes.
