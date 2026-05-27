# Design: Real-time Report SSE + Notification

## Context

`v0.9.0` shipped idea-completion reports via the `chorus_create_report` MCP tool, which writes a `Document` row with `type="report"` (no separate model). All other Chorus mutation paths fan out a `RealtimeEvent` through the in-process `EventBus`/Redis bridge so SSE-subscribed clients refetch automatically — but the document path doesn't. As of v0.9.0:

- `src/services/document.service.ts` contains **zero** `eventBus.emitChange()` calls (`grep` confirms).
- `src/components/idea-tracker/reports-list.tsx` (Idea overview pane) already calls `useRealtimeEntityTypeEvent("document", fetchReports)`, so a `document/created` event would be picked up *for free* — but the source-side emit doesn't exist.
- `src/components/idea-tracker/idea-tracker-list.tsx` only subscribes to `useRealtimeEntityTypeEvent("idea", ...)`, so its `reportCount` badge will not update on a `document/created` event without a parallel `idea/updated` event.
- `src/services/notification-listener.ts` is a single subscriber on the activity stream that does the recipient resolution + `t('notifications.types.<action>')` lookup. Adding a notification means: extend `resolveNotificationType`, add a recipient case, add a `buildMessage` case, optional `PREF_FIELD_MAP` entry, and add the i18n key in both `messages/{en,zh}.json`.

The user also chose: **no schema change**, **no UI highlight**, **deep-link to `panel=overview`** (not a Reports panel — the overview already renders reports inline below the timeline per `add-idea-completion-report` Requirement 5).

## Architecture

```
chorus_create_report (MCP tool, src/mcp/tools/public.ts)
    └─> documentService.createDocument({ ..., type: "report", proposalUuid })
            ├─> prisma.document.create(...)
            └─> NEW: if type === "report" {
                  ├─ eventBus.emitChange({ entityType: "document", action: "created", entityUuid: doc.uuid, projectUuid, companyUuid, actorUuid })
                  ├─ resolve ideaUuid from proposal.inputUuids[]
                  ├─ if ideaUuid resolved:
                  │    └─ eventBus.emitChange({ entityType: "idea", action: "updated", entityUuid: ideaUuid, ... })
                  └─ activity.recordActivity({
                       targetType: "idea", targetUuid: ideaUuid,
                       action: "report_created",
                       value: { reportUuid: doc.uuid, proposalUuid, reportTitle }
                     })
                       │  (ActivityEvent flows through eventBus "activity" channel)
                       ▼
                 notification-listener.ts.handleActivity
                   ├─ resolveNotificationType("idea", "report_created") → "report_created"
                   ├─ resolveRecipients() → [ideaCreator, ideaAssignee]
                   ├─ buildMessage("report_created", actorName, ideaTitle) → English fallback
                   └─ notificationService.createBatch([...])  (already emits per-recipient SSE)
                }
```

Why route through Activity rather than calling `notificationService.createBatch` directly from the document path: every other notifiable mutation in the codebase routes through Activity → notification-listener. Doing the same keeps the recipient-resolution + dedup + preference-filter logic in one place. The cost is one extra event on the bus per report — acceptable.

## Component contracts

### document.service.ts (modified)

```ts
export async function createDocument(params: {
  companyUuid: string;
  projectUuid: string;
  type: string;
  title: string;
  content: string;
  proposalUuid?: string;
  createdByUuid: string;
}): Promise<Document> {
  const doc = await prisma.document.create(...);

  if (params.type === "report") {
    // 1. Document-level SSE — picked up by ReportsList in IdeaDetailPanel
    eventBus.emitChange({
      companyUuid: params.companyUuid,
      projectUuid: params.projectUuid,
      entityType: "document",
      entityUuid: doc.uuid,
      action: "created",
      actorUuid: params.createdByUuid,
    });

    // 2. Resolve parent idea via proposal.inputUuids
    const ideaUuid = await resolveIdeaUuidFromProposal(params.proposalUuid);
    if (ideaUuid) {
      // 2a. Idea-level SSE — picked up by IdeaTrackerList for reportCount badge
      eventBus.emitChange({
        companyUuid: params.companyUuid,
        projectUuid: params.projectUuid,
        entityType: "idea",
        entityUuid: ideaUuid,
        action: "updated",
        actorUuid: params.createdByUuid,
      });

      // 2b. Activity event — drives notification-listener
      await activityService.recordActivity({
        companyUuid: params.companyUuid,
        projectUuid: params.projectUuid,
        targetType: "idea",
        targetUuid: ideaUuid,
        actorType: resolveActorType(params.createdByUuid),
        actorUuid: params.createdByUuid,
        action: "report_created",
        value: { reportUuid: doc.uuid, proposalUuid: params.proposalUuid, reportTitle: params.title },
      });
    }
  }

  return doc;
}
```

`resolveIdeaUuidFromProposal` reads `proposal.inputType` and `proposal.inputUuids` (a `Json` column already storing `string[]` of idea UUIDs for `inputType: "idea"`). Reports under non-idea-rooted proposals do not produce notifications — but they still emit the `document/created` event so the Reports panel refetches.

Failure semantics: any error inside the report-only branch is caught and logged via the existing module logger (`logger.child({ module: "document.service" })`). It does NOT roll back the Document insert — the Document is the source of truth, the side effects are best-effort. This matches `idea.service.ts`'s pattern (eventBus errors don't fail the write). Logged at `warn` so they are visible without crashing the request.

### notification-listener.ts (modified)

Three additions:

```ts
// resolveNotificationType()
const mapping = {
  // ... existing entries ...
  "idea:report_created": "report_created",
};

// resolveRecipients() — new case
case "report_created": {
  const idea = await prisma.idea.findUnique({
    where: { uuid: targetUuid },
    select: {
      createdByUuid: true,
      assigneeType: true,
      assigneeUuid: true,
    },
  });
  if (!idea) return [];
  const recipients: Recipient[] = [
    { type: "user", uuid: idea.createdByUuid },
  ];
  if (idea.assigneeType && idea.assigneeUuid) {
    recipients.push({
      type: idea.assigneeType as "user" | "agent",
      uuid: idea.assigneeUuid,
    });
  }
  return recipients;
  // dedup + actor-exclusion happens upstream in handleActivity
}

// buildMessage() — new case
case "report_created":
  return `${actorName} generated a new report on idea "${entityTitle}"`;
```

No `PREF_FIELD_MAP` entry this iteration — that was decided in elaboration as "no new preference toggle". Recipients always get the notification (subject to the global dedup + actor-exclusion).

### messages/en.json + messages/zh.json

```json
// en
"notifications.types.report_created": "New report"
// zh
"notifications.types.report_created": "新报告"
```

The bell popup renders this as the row title; the row body uses `actorName` + `entityTitle` from the notification payload, also already-i18n'd.

### notification-popup.tsx (modified)

The deep-link router builds the URL based on the row's `entityType` + `entityUuid`. For `action === "report_created"` we want **the notification's parent Idea**, not the Document. Since the activity stream uses `targetType: "idea"`, `targetUuid: ideaUuid`, the existing entity-type lookup already produces the right Idea pointer. The new branch:

```ts
if (notif.action === "report_created") {
  return `/projects/${notif.projectUuid}/dashboard?ideaUuid=${notif.entityUuid}&panel=overview`;
}
```

The `IdeaDetailPanel` already supports `panel=overview` as the default tab — verified via reading `idea-detail-panel.tsx`.

## Data model

**No Prisma schema change.** The `Notification.action` column is `String` (not enum), so adding `"report_created"` requires only application-code changes.

## Failure / error handling

| Source | Handling |
|---|---|
| `eventBus.emitChange` throws | Caught in service code, logged at `warn`. Document insert succeeds. Subscribers will not refetch — user sees the report on next manual refresh. |
| `activityService.recordActivity` throws | Same — caught, logged, no rollback. |
| `notification-listener.handleActivity` throws | Already wrapped in `try/catch` upstream (line ~570). |
| Idea cannot be resolved (proposal not idea-rooted) | Skip notification path entirely. Document event still fires. |

## Testing

| Test | File | What it asserts |
|---|---|---|
| Service-layer unit | `src/services/__tests__/document.service.test.ts` | Calling `createDocument({ type: "report", ... })` invokes `eventBus.emitChange` with `entityType: "document"` AND `entityType: "idea"`, and `activityService.recordActivity` with `action: "report_created"`. Calling with `type: "prd"` emits NEITHER. |
| Notification-listener unit | `src/services/__tests__/notification-listener.test.ts` | Activity event with `action: "report_created"` resolves recipients to `[ideaCreator, ideaAssignee]` (deduped, actor excluded), produces `notification.action === "report_created"`. |
| i18n smoke | `src/components/__tests__/notification-popup.test.tsx` | Mounted popup renders the i18n string for both `en` and `zh` locales given a `report_created` notification fixture. |
| Frontend hook integration | `src/contexts/__tests__/realtime-context.test.tsx` | Mount a component using `useRealtimeEntityTypeEvent("document", cb)`, dispatch a fake `change` event with `entityType: "document"`, assert `cb` runs (debounced). |

E2E with real DB + browser is **out of scope** per elaboration Q7 = (b).

## Risks

| Risk | Mitigation |
|---|---|
| Adding `idea/updated` events on every report creation triggers extra refetches on IdeaTrackerList. | Acceptable — the tracker list is small (≤ 50 ideas) and fetches are cheap. |
| `notification-listener.ts` recipient resolution is centralized; an error in the new case could break unrelated notifications. | The `try/catch` in `handleActivity` already isolates failures; the new case is added in the per-action `switch` so its scope is narrow. |
| Future "report update" feature (out of scope today) would need a parallel emit on `chorus_pm_update_document` when the underlying type is `report`. | Documented in the spec scenario "Updates do not produce a notification (out of scope)" so the constraint is explicit, not implicit. |

## Out of scope

- Report `update`/`delete` events (Q1 = "only create").
- New `NotificationPreference` toggle (Q2 = creator + assignee, no opt-out).
- "X new" highlight banner (Q5 = "no highlight").
- E2E test (Q7 = "service + frontend hook").
