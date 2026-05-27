## Why

Idea-completion reports added in v0.9.0 land via the `chorus_create_report` MCP tool — but creating one produces no real-time feedback for the user. The dashboard already wires SSE for comments, mentions, task changes, and even document changes elsewhere; the report-creation path is the only one that requires a manual page refresh to see the new artifact. Users miss new reports unless they happen to be looking at the right page at the right time.

## What Changes

- Creating a `Document` with `type="report"` SHALL fan out two `RealtimeEvent`s through the existing `EventBus`: one for the document itself (so the Idea overview's `ReportsList` refetches) and one for the parent Idea (so the Idea Tracker's `reportCount` badge refetches).
- Creating a `Document` with `type="report"` SHALL produce one `Notification` per (Idea creator, Idea assignee) — deduplicated, excluding the actor themselves — using the existing `notification-listener.ts` machinery and the new action value `report_created`.
- The notification's display text SHALL be rendered client-side via the existing `t('notifications.types.<action>')` pattern. Two i18n strings (en + zh) are added under that key. **No Prisma schema change.**
- The bell-popup's notification row for `report_created` SHALL deep-link to `/projects/<projectUuid>/dashboard?ideaUuid=<ideaUuid>&panel=overview` — the Idea overview panel already renders `ReportsList` inline.

## Capabilities

### New Capabilities
- `report-realtime`: Real-time SSE fan-out and notification production triggered when an idea-completion Report is created.

### Modified Capabilities
- _(none)_ — `idea-completion-report` is in-flight (not yet archived to `openspec/specs/`); this change therefore introduces a separate capability rather than modifying a spec that doesn't exist long-term yet.

## Impact

- `src/services/document.service.ts` (or `chorus_create_report` tool path) — emit `eventBus.emitChange()` twice and call notification creation, **only when `type === "report"`**.
- `src/services/notification.service.ts` (or `notification-listener.ts`) — extend the action enum with `report_created`; add a `buildMessage()` branch.
- `messages/en.json` + `messages/zh.json` — add `notifications.types.report_created`.
- `src/components/notification-popup.tsx` — extend the deep-link router so `action === "report_created"` builds the dashboard URL with `panel=overview`.
- Tests:
  - service-layer unit test: report create emits both events + creates notifications for the right recipients.
  - frontend hook integration test: mount `useRealtimeEntityTypeEvent` with a fake event source and assert the refetch callback fires.
- No schema migration. No new Prisma model. No new MCP tool.
