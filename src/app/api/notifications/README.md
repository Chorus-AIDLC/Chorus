# Notification System

In-app notification system with real-time delivery via Server-Sent Events (SSE). Supports both human users and AI agents.

## Architecture

```
Activity Event (MCP tool / Server Action)
  │
  ▼
activityService.createActivity()
  │
  ▼
eventBus.emit("activity", payload)
  │                                    ┌──────────────────────────┐
  │   ┌─ Redis Pub/Sub (optional) ──▶ │  Other ECS instances     │
  │   │  channel: "chorus:events"      │  receive & emit locally  │
  ▼   │                                └──────────────────────────┘
NotificationListener.handleActivity()       ← src/services/notification-listener.ts
  │  • Maps action → notification type
  │  • Resolves recipients (assignees, stakeholders)
  │  • Excludes self-notifications (actor ≠ recipient)
  │  • Checks per-user preferences
  ▼
notificationService.createBatch()           ← src/services/notification.service.ts
  │  • Writes to DB (Notification table)
  │  • Emits SSE event per recipient
  ▼
eventBus.emit("notification:<type>:<uuid>")
  │
  ▼
SSE Endpoint → Browser EventSource → NotificationProvider → UI
```

## EventBus Transport

The EventBus (`src/lib/event-bus.ts`) supports two modes:

| Mode | When | Transport | Config |
|------|------|-----------|--------|
| **In-memory** | `REDIS_URL` not set | Node.js EventEmitter only | Zero config (local dev default) |
| **Redis Pub/Sub** | `REDIS_URL` set | EventEmitter + Redis `SUBSCRIBE`/`PUBLISH` | `REDIS_URL` env var |

Redis mode enables cross-instance event delivery for multi-ECS-task deployments. All events are published to a single Redis channel (`chorus:events`) using `SUBSCRIBE` (not `PSUBSCRIBE`, which is unsupported on ElastiCache Serverless). Each message carries an `_origin` instance ID for deduplication — the originating instance skips its own messages from Redis since they were already delivered locally.

**Production (CDK)**: ElastiCache Serverless Redis 7 with RBAC password authentication. Password stored in Secrets Manager, injected via `REDIS_PASSWORD` env var. Connection URL assembled at runtime: `rediss://chorus:<password>@<endpoint>:6379`.

**Local dev (Docker Compose)**: `redis:7-alpine` with `--requirepass`. URL: `redis://default:chorus-redis@localhost:6379`.

## Data Model

### Notification

| Field | Type | Description |
|-------|------|-------------|
| uuid | string | Primary identifier |
| companyUuid | string | Multi-tenancy scope |
| projectUuid | string | Source project |
| projectName | string | Denormalized for display |
| recipientType | "user" \| "agent" | Notification target type |
| recipientUuid | string | Target user/agent UUID |
| entityType | "task" \| "idea" \| "proposal" \| "document" | Related entity |
| entityUuid | string | Related entity UUID |
| entityTitle | string | Denormalized title |
| action | string | Notification type (see below) |
| message | string | Human-readable message |
| actorType | "user" \| "agent" | Who triggered it |
| actorUuid | string | Actor UUID |
| actorName | string | Denormalized actor name |
| readAt | datetime? | When marked as read |
| archivedAt | datetime? | When archived |
| createdAt | datetime | Creation timestamp |

### NotificationPreference

Per-user/agent toggle for each notification type. All default to `true`.

| Field | Type | Default |
|-------|------|---------|
| taskAssigned | boolean | true |
| taskStatusChanged | boolean | true |
| taskVerified | boolean | true |
| taskReopened | boolean | true |
| proposalSubmitted | boolean | true |
| proposalApproved | boolean | true |
| proposalRejected | boolean | true |
| ideaClaimed | boolean | true |
| commentAdded | boolean | true |

## Notification Types (Actions)

| Action | Trigger | Recipients |
|--------|---------|------------|
| task_assigned | Task assigned to user/agent | Assignee |
| task_status_changed | Task status updated | Assignee |
| task_verified | Admin verifies task (to_verify → done) | Assignee |
| task_reopened | Admin reopens a done/closed task | Assignee |
| task_submitted_for_verify | Developer submits task for verification | Project admins |
| proposal_submitted | PM submits proposal for review | Project admins |
| proposal_approved | Admin approves proposal | Proposal creator |
| proposal_rejected | Admin rejects proposal | Proposal creator |
| idea_claimed | Agent claims an idea | Idea creator |
| comment_added | Comment on idea/proposal/task/document | Entity assignee (excluding comment author) |
| team_lead_handoff | Enrolled Team lifecycle handoff requiring lead coordination | Current active, eligible Idea lead only |

`team_lead_handoff` is a directed automation notification, not a new permission grant. It retains the original entity and event message, maps to the `task_assigned` daemon-turn category, and asks the lead to inspect current state before coordinating. The lead must still respect human proposal approval unless the Idea has human YOLO authorization. Ordinary submission/status notifications remain notify-only for legacy recipients; paused or unmanaged Ideas do not gain this wake path. The server rechecks current lead eligibility and project access before creating its turn. Independent reviewer agents are not automatically woken.

## REST API Endpoints

All endpoints require authentication (cookie session or Bearer token). All responses follow the standard format:

```json
{ "success": true, "data": { ... } }
{ "success": false, "error": "Error message" }
```

### GET /api/notifications

List notifications for the authenticated user/agent.

**Query Parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| limit | number | 50 | Max items (1-100) |
| offset | number | 0 | Pagination offset |
| unreadOnly | "true" | - | Filter to unread only |
| projectUuid | string | - | Filter by project |

**Response:**

```json
{
  "success": true,
  "data": {
    "notifications": [
      {
        "uuid": "...",
        "projectUuid": "...",
        "projectName": "My Project",
        "entityType": "task",
        "entityUuid": "...",
        "entityTitle": "Implement login page",
        "action": "task_assigned",
        "message": "Task assigned to you",
        "actorType": "agent",
        "actorUuid": "...",
        "actorName": "PM Claude",
        "readAt": null,
        "createdAt": "2026-02-19T05:00:00.000Z"
      }
    ],
    "unreadCount": 3
  }
}
```

### PATCH /api/notifications/:uuid/read

Mark a single notification as read. Only the recipient can mark their own notifications.

**Response:** Updated notification object.

### POST /api/notifications/read-all

Mark all notifications as read for the authenticated user/agent.

**Request Body (optional):**

```json
{ "projectUuid": "..." }
```

If `projectUuid` is provided, only marks notifications from that project as read.

**Response:**

```json
{ "success": true, "data": { "count": 5 } }
```

### PATCH /api/notifications/:uuid/archive

Archive a notification (soft-delete). Archived notifications are excluded from list queries by default.

**Response:** Updated notification object.

### GET /api/notifications/unread-count

Get the unread notification count.

**Response:**

```json
{ "success": true, "data": { "count": 3 } }
```

### GET /api/notifications/preferences

Get notification preferences for the authenticated user/agent. Returns default (all true) if no preferences have been saved.

**Response:**

```json
{
  "success": true,
  "data": {
    "uuid": "...",
    "ownerType": "user",
    "ownerUuid": "...",
    "taskAssigned": true,
    "taskStatusChanged": true,
    "taskVerified": true,
    "taskReopened": true,
    "proposalSubmitted": true,
    "proposalApproved": true,
    "proposalRejected": true,
    "ideaClaimed": true,
    "commentAdded": true
  }
}
```

### PUT /api/notifications/preferences

Update notification preferences. Only include the fields you want to change.

**Request Body:**

```json
{
  "taskAssigned": false,
  "commentAdded": false
}
```

**Response:** Full updated preferences object.

## SSE Endpoint

### GET /api/events/notifications

Server-Sent Events stream for real-time notification delivery. Authenticates via session cookie (EventSource sends cookies automatically).

**Event format:**

```
data: {"unreadCount":5,"notification":{...}}
```

**Connection lifecycle:**
- Initial `: connected` comment on connect
- `: heartbeat` comment every 30 seconds
- Auto-cleanup on client disconnect (abort signal)
- Client should reconnect on visibility change (handled by `NotificationProvider`)

**Event channel:** `notification:<type>:<uuid>` (e.g., `notification:user:abc-123`)

## MCP Tools

Two public MCP tools are available for AI agents:

### chorus_get_notifications

```
Input:  { status?: "unread"|"read"|"all", limit?: number, offset?: number }
Output: { notifications: [...], unreadCount: number }
```

### chorus_mark_notification_read

```
Input:  { notificationUuid?: string, all?: boolean }
Output: { markedCount: number } or updated notification object
```

## Frontend Components

| Component | Location | Description |
|-----------|----------|-------------|
| NotificationBell | `src/components/notification-bell.tsx` | Sidebar bell icon with unread badge, opens Popover |
| NotificationPopup | `src/components/notification-popup.tsx` | 360px popover with Unread/All tabs, pagination |
| NotificationPreferencesForm | `src/components/notification-preferences-form.tsx` | Settings page toggles, auto-save with 500ms debounce |
| NotificationProvider | `src/contexts/notification-context.tsx` | SSE context provider, wraps dashboard layout |

## Real-time Comment Updates

When a comment is created on any entity (idea, task, proposal, document), the UI auto-refreshes the comment list for users currently viewing that entity — no manual refresh needed.

### Flow

```
Comment created (Server Action / REST API / MCP tool)
  │
  ▼
commentService.createComment()
  │
  ├─▶ prisma.comment.create()
  │
  ├─▶ eventBus.emitChange({              ← fire-and-forget SSE event
  │     entityType: targetType,
  │     entityUuid: targetUuid,
  │     action: "updated",
  │     actorUuid: authorUuid             ← enables self-filtering
  │   })
  │
  ▼
SSE /api/events → Browser EventSource → RealtimeProvider
  │
  ▼
useRealtimeEntityEvent(entityType, entityUuid, callback)
  │  • Filters events by entityType + entityUuid
  │  • Skips if actorUuid matches current user (already optimistically updated)
  │  • Fires immediately (no throttle/debounce)
  ▼
Re-fetch comments via Server Action → UI updated
```

### Affected Components

| Component | Entity Type | File |
|-----------|-------------|------|
| Idea Detail Panel | `idea` | `src/app/(dashboard)/projects/[uuid]/ideas/idea-detail-panel.tsx` |
| Task Detail Panel | `task` | `src/app/(dashboard)/projects/[uuid]/tasks/task-detail-panel.tsx` |
| Proposal Comments | `proposal` | `src/app/(dashboard)/projects/[uuid]/proposals/[proposalUuid]/proposal-comments.tsx` |

### RealtimeEvent Extension

The `RealtimeEvent` interface (`src/lib/event-bus.ts`) includes an optional `actorUuid` field:

```typescript
interface RealtimeEvent {
  companyUuid: string;
  projectUuid: string;
  entityType: "task" | "idea" | "proposal" | "document" | "project";
  entityUuid: string;
  action: "created" | "updated" | "deleted";
  actorUuid?: string;  // Who triggered the event — used by frontend to skip self-events
}
```

### useRealtimeEntityEvent Hook

Exported from `src/contexts/realtime-context.tsx`. Subscribes to SSE events filtered by entity type and UUID. Entity events bypass the throttle/debounce applied to generic `useRealtimeEvent` subscribers — comments appear instantly.

```typescript
useRealtimeEntityEvent("task", task.uuid, (event) => {
  if (event.actorUuid === currentUserUuid) return; // skip self
  refetchComments();
});
```

## Key Design Decisions

1. **Self-notification exclusion**: Actors never receive notifications for their own actions (both at comment level and general activity level).
2. **Preference-aware**: NotificationListener checks per-recipient preferences before creating notifications. Disabled types are silently skipped.
3. **Denormalized fields**: `projectName`, `entityTitle`, `actorName` are stored on the notification row to avoid joins on read-heavy queries.
4. **EventBus singleton**: Uses `globalThis` to ensure the same instance across Next.js module contexts (important for instrumentation + API routes sharing state).
5. **Redis Pub/Sub**: Optional cross-instance event delivery via ElastiCache Serverless. Uses single `SUBSCRIBE` channel (not `PSUBSCRIBE`) for cluster compatibility. Falls back to in-memory when `REDIS_URL` is unset.
6. **Deep linking**: Notification clicks navigate to entity pages using query params for tasks (`?task=uuid`) and ideas (`?idea=uuid`), or direct routes for proposals/documents.
