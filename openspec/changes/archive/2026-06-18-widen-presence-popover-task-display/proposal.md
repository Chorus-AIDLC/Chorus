# Widen the presence popover & make agent task rows readable

## Why

The sidebar online-agent presence pill (capability `agent-connection-observability`)
ships with a click popover that lists each online connection's `running` / `queued`
executions. The popover container is hard-fixed at **`w-[300px]`**, and every row is
rendered by the shared `ExecutionRow`, which lays out a lot horizontally on one line:
a 32px icon tile, an entity-type badge, the **truncated** task title, an external-link
glyph, and — for `running` rows — an elapsed timer plus an Interrupt button (both
non-shrinking).

At 300px the title is squeezed to roughly 100px and truncates hard; the root-idea
session line truncates too. The net effect users reported after the v1/v2 ship:
"弹层太窄，agent 任务内容显示不完" — you can see *that* an agent is busy, but not *what*
task it is on. The popover's whole job is to answer "what is each online agent doing
right now", and truncation defeats that.

This change is **purely the popover's task display**: the wide "View all" modal
(1100px) reads fine and is out of scope.

## What Changes

- **Widen the popover** from `w-[300px]` to `w-[min(92vw,400px)]` — wider on desktop,
  viewport-clamped so it never overflows a phone. Roughly doubles the title's room.
- **Add a roomy two-line layout variant to `ExecutionRow`** (opt-in via a prop, e.g.
  `layout="stacked"`), used **only by the popover**: the task title gets its own line
  and can wrap/show more before truncating; the elapsed timer + Interrupt control move
  to a second line so they no longer compete with the title for horizontal width. The
  modal and the (modal-hosted) connection view keep the existing single-line layout
  unchanged (default prop value).
- **Keep the popover actionable**: the elapsed timer and the Interrupt control remain
  in the popover (owner's decision), just relaid out so they don't crowd the title.

## Capabilities

- `agent-connection-observability` — ADD one requirement constraining the popover's
  execution-row task display (width + readable title + non-crowding controls). No
  existing requirement is modified or removed; the existing popover requirement left
  width and row layout unspecified, so this is purely additive.

## Impact

- **Frontend only.** `src/components/agent-presence-pill.tsx` (popover width + pass the
  stacked layout prop), `src/components/agent-presence/execution-row.tsx` (add the
  opt-in two-line variant). `messages/en.json` + `messages/zh.json` only if a new
  string is introduced (not expected — no new copy planned).
- **No** change to the data layer, the `AgentPresenceProvider` spine, the
  `GET /api/daemon/executions` / `GET /api/agent-connections` APIs, the popover's
  information architecture (running/queued grouping; interrupted stays modal-only), or
  the modal / connection-view layout.
- **No** schema change, migration, or new permission bit.
- Existing pill/popover and execution-row unit tests updated to assert the new popover
  width and the stacked-row layout; modal continues to assert the single-line layout.
