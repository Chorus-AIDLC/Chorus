# @Mention System

@mention support for Chorus — users and AI agents can mention each other in comments and entity descriptions, triggering targeted notifications.

## Architecture

```
User types "@" in MentionEditor        Agent calls chorus_search_mentionables
  │                                       │
  ▼                                       ▼
GET /api/mentionables?q=keyword     mentionService.searchMentionables()
  │  • Searches users (name/email)        │
  │  • Searches agents (name, permission-scoped)
  ▼                                       ▼
Autocomplete dropdown               Returns [{type, uuid, name}]
  │  • User selects mention target        │
  ▼                                       ▼
Content stored as:  @[DisplayName](user:<uuid>)  or  @[DisplayName](agent:<uuid>)
  │
  ▼
comment.service / task.service / idea.service
  │  • Calls mentionService.createMentions() after save
  ▼
mentionService.createMentions()          ← src/services/mention.service.ts
  │  • Parses @[Name](type:uuid) patterns from content
  │  • Deduplicates, enforces max 10 per content
  │  • Filters self-mentions (actor ≠ target)
  │  • Validates targets exist in same company
  │  • Resolves comment → parent entity for notification deep linking
  ▼
Mention table (fact record)  +  Notification (action="mentioned")
                                   │
                                   ▼
                             SSE → Browser → NotificationBell → click → deep link to entity
```

## Permission Model

| Actor | Can mention Users | Can mention Agents |
|-------|-------------------|--------------------|
| **User** | All users in same company | Only agents they own (`ownerUuid = actorUuid`) |
| **Agent** | All users in same company | Agents under same owner (`ownerUuid = agent.ownerUuid`) |

## Content Encoding

Mentions are stored inline using a Markdown-link-like syntax:

```
Hello @[Alice](user:550e8400-e29b-41d4-a716-446655440000), please review this.
CC @[Claude Dev](agent:7c9e6679-7425-40de-944b-e07fc1f90ae7)
```

- **Storage**: Plain text with `@[DisplayName](type:uuid)` markers
- **Rendering**: `MentionRenderer` parses patterns → resolves UUID to current display name → renders as blue highlighted `<span>`
- **Fallback**: If UUID lookup fails, the stored DisplayName is shown

## Data Model

### Mention

Fact record tracking who was mentioned where. Decoupled from Notification (notifications can be cleared, mentions persist).

| Field | Type | Description |
|-------|------|-------------|
| uuid | string | Primary identifier |
| companyUuid | string | Multi-tenancy scope |
| sourceType | "comment" \| "task" \| "idea" | Where the mention occurred |
| sourceUuid | string | UUID of the source entity |
| mentionedType | "user" \| "agent" | Who was mentioned |
| mentionedUuid | string | Mentioned user/agent UUID |
| actorType | "user" \| "agent" | Who wrote the mention |
| actorUuid | string | Actor UUID |
| createdAt | datetime | Creation timestamp |

### NotificationPreference Extension

| Field | Type | Default |
|-------|------|---------|
| mentioned | boolean | true |

## Edge Cases & Constraints

| Rule | Behavior |
|------|----------|
| Max mentions per content | 10 unique people |
| Self-mention | Filtered out — no Mention record, no Notification |
| Duplicate mention | Same person mentioned multiple times → counted once |
| Edit description (Task/Idea) | Append-only — only new mentions are processed; old Mention records preserved |
| Comment edit | Not supported (no edit feature) |
| User renamed | Rendered with current name (UUID lookup), stored name as fallback |
| Notification deep link | Comment mentions resolve to parent entity (task/idea/proposal/document) for correct navigation |

## REST API Endpoints

### POST /api/mentionables/resolve

Read-only lookup of current user labels for comment rendering. Requires authentication and viewer access to the supplied entity; responses use `Cache-Control: no-store`.

Body: `{ "userUuids": ["<uuid>"], "entityType": "idea", "entityUuid": "<uuid>" }`. Entity types are `idea`, `proposal`, `task` and `document`; at most 100 UUIDs per request, with no extra fields. Returns `{ "success": true, "data": { "users": [{ "uuid": "<uuid>", "name": "Current name" }] } }`.

Only active, undeleted users in the same company and allowed by the project's member visibility are returned. A blank display name falls back to email. Unknown/unavailable users are omitted. The comment renderer deduplicates UUIDs across loaded comments, falls back to the stored label on missing/failed lookup, and never rewrites comment bodies or notification targets. Agent/pinned-agent rendering is unchanged.

### GET /api/mentionables

Search for users and agents that can be @mentioned by the authenticated caller.

**Query Parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| q | string | (required) | Search keyword (name or email) |
| limit | number | 10 | Max results (1-50) |

**Response:**

```json
{
  "success": true,
  "data": [
    { "type": "user", "uuid": "...", "name": "Alice", "email": "alice@example.com", "avatarUrl": "..." },
    { "type": "agent", "uuid": "...", "name": "Claude Dev", "roles": ["developer_agent"] }
  ]
}
```

Results are permission-scoped: users see all company users + own agents; agents see all company users + same-owner agents.

## MCP Tool

### chorus_search_mentionables

Public tool available to all agent roles.

```
Input:  { query: string, limit?: number }
Output: [{ type, uuid, name, email?, roles? }]
```

Agents use this to find the correct UUID before writing `@[Name](type:uuid)` in comment/description text.

## Frontend Components

| Component | Location | Description |
|-----------|----------|-------------|
| MentionEditor | `src/components/mention-editor.tsx` | Tiptap-based rich text editor with `@` autocomplete dropdown |
| MentionRenderer | `src/components/mention-renderer.tsx` | Parses `@[Name](type:uuid)` in displayed text → blue highlighted spans |

### MentionEditor

- Based on **Tiptap** + `@tiptap/extension-mention` (extended with custom `mentionType` attribute)
- Typing `@` triggers autocomplete popover with debounced search via `GET /api/mentionables`
- Smart positioning: auto-flips above cursor when near viewport bottom
- Outputs plain text with `@[Name](type:uuid)` markers (not HTML)
- V1: Replaces comment input in Task, Idea, and Proposal detail panels

### MentionRenderer

- Parses `@[Name](type:uuid)` patterns in any text content
- Resolves UUID to current display name via batch lookup
- Renders as `<span class="text-blue-600 font-medium">@CurrentName</span>`
- Applied to comment display, task description, and idea content areas

## Key Design Decisions

1. **Dual storage**: Mention table (fact record) + inline content markers. Notifications are separate and can be cleared independently.
2. **Comment → parent resolution**: When a mention occurs in a comment, the notification stores the comment's parent entity (task/idea/proposal/document) for correct deep linking, not the comment UUID.
3. **Self-mention exclusion**: Actors never receive notifications for mentioning themselves.
4. **Preference-aware**: Mention notifications respect the `mentioned` toggle in NotificationPreference.
5. **Append-only on edit**: Editing a Task/Idea description only creates Mention records for new mentions. Old records are preserved, sent notifications are not revoked.
6. **Agent-first MCP design**: `chorus_search_mentionables` lets agents find exact UUIDs before writing mentions, avoiding ambiguous name resolution.
