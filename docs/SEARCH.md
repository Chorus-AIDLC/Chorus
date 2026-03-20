# Global Search — Technical Design

**Version**: 1.0
**Updated**: 2026-03-20

---

## 1. Overview

Chorus Global Search provides unified search across 6 entity types: Task, Idea, Proposal, Document, Project, and Project Group. Users and AI agents can quickly locate any entity via the REST API, MCP tool, or the Cmd+K command palette UI.

## 2. Architecture

```
┌─────────────────────────────────────────────────┐
│  Frontend (global-search.tsx)                    │
│  Cmd+K Dialog · Filter Tabs · Keyboard Nav      │
│  Scope Selector (Global / Group / Project)       │
└──────────────────┬──────────────────────────────┘
                   │ GET /api/search?q=...&scope=...
                   ▼
┌─────────────────────────────────────────────────┐
│  REST API (api/search/route.ts)                  │
│  Auth · Param Validation · Scope Resolution      │
└──────────────────┬──────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────┐
│  Search Service (search.service.ts)              │
│  6 parallel Prisma queries · Snippet Generation  │
│  Unified Sort · Scope Filtering · Counts         │
└──────────────────┬──────────────────────────────┘
                   │
    ┌──────────────┼──────────────┐
    ▼              ▼              ▼
┌────────┐  ┌──────────┐  ┌───────────┐
│  Task  │  │   Idea   │  │ Proposal  │  ...
│  table │  │   table  │  │   table   │
└────────┘  └──────────┘  └───────────┘

┌─────────────────────────────────────────────────┐
│  MCP Tool (chorus_search)                        │
│  Registered in public.ts · All roles             │
│  Same search.service.search() backend            │
└─────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────┐
│  OpenClaw Plugin (common-tools.ts)               │
│  Proxy tool → mcpClient.callTool()               │
└─────────────────────────────────────────────────┘
```

## 3. Searchable Entities & Fields

| Entity | Search Fields | Status Field | Scope Filtering |
|--------|--------------|--------------|-----------------|
| Task | title, description | status | projectUuid |
| Idea | title, content | status | projectUuid |
| Proposal | title, description | status | projectUuid |
| Document | title, content | type (as status) | projectUuid |
| Project | name, description | "active" (fixed) | uuid directly |
| Project Group | name, description | "active" (fixed) | uuid directly |

## 4. Search Strategy

### 4.1 Current: ILIKE Substring Matching

All queries use Prisma's `contains` with `mode: "insensitive"`, which translates to PostgreSQL `ILIKE '%keyword%'`.

```typescript
where: {
  companyUuid,
  OR: [
    { title: { contains: query, mode: "insensitive" } },
    { description: { contains: query, mode: "insensitive" } },
  ],
}
```

**Pros**: Simple, no extra dependencies, no schema changes.
**Cons**: No relevance ranking, no CJK word segmentation, performance degrades on large datasets.

### 4.2 Future: PostgreSQL Full-Text Search

When needed, migrate to `to_tsvector` / `to_tsquery` with GIN indexes for:
- Relevance ranking (`ts_rank`)
- Match highlighting (`ts_headline`)
- Multi-language support (English + Chinese via `zhparser`)

## 5. Scope System

Three scope levels control the search boundary:

| Scope | Behavior | Parameter |
|-------|----------|-----------|
| `global` | All entities in the company | None |
| `group` | All projects within a Project Group | `scopeUuid` = group UUID |
| `project` | Single project | `scopeUuid` = project UUID |

### Scope Resolution

```
global  → no projectUuid filter
group   → resolveGroupProjects(groupUuid) → projectUuid IN [...]
project → projectUuid = scopeUuid
```

For `group` scope, the service first queries all project UUIDs belonging to the group, then uses `projectUuid: { in: [...] }` for filtering. Project and Project Group entities have their own scope logic (e.g., project scope returns only that project if it matches).

### Scope Intelligence (UI)

The frontend automatically selects the default scope based on the current page:

| Current Page | Default Scope |
|-------------|---------------|
| `/projects` (global) | Global |
| `/project-groups/{uuid}` | Group (with group name) |
| `/projects/{uuid}/*` | This Project (with project name) |

Users can manually switch scope via the dropdown in the search header.

## 6. API Design

### 6.1 REST API

```
GET /api/search?q=keyword&scope=global&scopeUuid=xxx&types=task,idea&limit=20
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `q` | string | Yes | - | Search query |
| `scope` | enum | No | `global` | `global` \| `group` \| `project` |
| `scopeUuid` | string | No | - | Required when scope is `group` or `project` |
| `types` | string | No | all | Comma-separated: `task,idea,proposal,document,project,project_group` |
| `limit` | number | No | 20 | Max results (1-100) |

**Response**:

```json
{
  "success": true,
  "data": {
    "results": [
      {
        "entityType": "task",
        "uuid": "...",
        "title": "...",
        "snippet": "...matched context...",
        "status": "in_progress",
        "projectUuid": "...",
        "projectName": "...",
        "updatedAt": "2026-03-20T..."
      }
    ],
    "counts": {
      "tasks": 3, "ideas": 2, "proposals": 1,
      "documents": 4, "projects": 1, "projectGroups": 1
    }
  }
}
```

### 6.2 MCP Tool

```
chorus_search({
  query: "keyword",
  scope?: "global" | "group" | "project",
  scopeUuid?: "uuid",
  entityTypes?: ["task", "idea", "proposal", "document", "project", "project_group"]
})
```

Registered in `public.ts` — available to all agent roles (PM, Developer, Admin).

## 7. Search Execution

### 7.1 Parallel Query

All 6 entity type queries execute in parallel via `Promise.all()`. Each query returns both results (with `take: limit`) and a count (total matches).

```typescript
const searchPromises = [
  searchTasks(companyUuid, query, projectUuids, limit),
  searchIdeas(companyUuid, query, projectUuids, limit),
  searchProposals(companyUuid, query, projectUuids, limit),
  searchDocuments(companyUuid, query, projectUuids, limit),
  searchProjects(companyUuid, query, projectUuids, limit),
  searchProjectGroups(companyUuid, query, groupUuid, limit),
];
const searchResults = await Promise.all(searchPromises);
```

### 7.2 Result Merging & Sorting

Results from all entity types are merged into a single array, sorted by `updatedAt` descending, then truncated to the requested `limit`.

### 7.3 Snippet Generation

For each result, a ~100 character snippet is extracted around the first match position:

1. Find the match position in the text (case-insensitive)
2. Calculate a window centered on the match
3. Adjust start to a word boundary if possible
4. Add ellipsis markers (`...`) when truncated

If the query doesn't match in the description/content, the beginning of the text is returned instead.

## 8. Frontend Design

### 8.1 Cmd+K Command Palette

The search UI is a Dialog-based command palette, inspired by Linear and Notion:

- **Trigger**: Sidebar button (desktop) / Header icon (mobile) / `Cmd+K` keyboard shortcut
- **Search Header**: Input field + Scope selector dropdown
- **Filter Tabs**: All / Tasks / Ideas / Proposals / Documents / Projects (server-side filtering)
- **Results List**: Scrollable list with keyboard navigation
- **Footer**: Keyboard hints (desktop only)

### 8.2 Keyboard Navigation

| Key | Action |
|-----|--------|
| `Cmd+K` / `Ctrl+K` | Open search dialog |
| `Esc` | Close dialog |
| `↑` / `↓` | Navigate results |
| `Enter` | Open selected result |

Selected result is visually highlighted and auto-scrolls into view.

### 8.3 Filter Tabs (Server-Side)

Clicking a filter tab sends a new API request with `types=<selected_type>`, returning up to 20 results of that specific type. This ensures the user sees the full Top 20 of each type, not just what happened to be in the mixed Top 20.

### 8.4 Responsive Design

| Aspect | Desktop | Mobile |
|--------|---------|--------|
| Trigger | Sidebar button with text + ⌘K badge | Header icon button |
| Dialog position | `top: 20%` | `top: 1rem` |
| Dialog width | `max-w: 600px` | `100vw - 2rem` |
| Footer hints | Visible | Hidden |
| Filter tabs | Inline | Horizontally scrollable |

### 8.5 Navigation

Clicking a result navigates to the entity's detail page:

| Entity Type | Route |
|-------------|-------|
| Task | `/projects/{projectUuid}/tasks/{taskUuid}` |
| Idea | `/projects/{projectUuid}/ideas/{ideaUuid}` |
| Proposal | `/projects/{projectUuid}/proposals/{proposalUuid}` |
| Document | `/projects/{projectUuid}/documents/{documentUuid}` |
| Project | `/projects/{projectUuid}/dashboard` |
| Project Group | `/projects` |

## 9. File Map

| File | Purpose |
|------|---------|
| `src/services/search.service.ts` | Core search logic, types, snippet generation |
| `src/services/__tests__/search.service.test.ts` | 16 unit tests (90%+ branch coverage) |
| `src/app/api/search/route.ts` | REST API endpoint |
| `src/components/global-search.tsx` | Cmd+K dialog component |
| `src/app/(dashboard)/layout.tsx` | Search trigger integration |
| `src/mcp/tools/public.ts` | `chorus_search` MCP tool |
| `packages/openclaw-plugin/src/tools/common-tools.ts` | OpenClaw proxy tool |
| `messages/en.json` / `messages/zh.json` | i18n keys under `search.*` |
| `docs/design.pen` | UI mockup (frame: "Chorus - Global Search") |

## 10. Multi-tenancy

All search queries are scoped by `companyUuid` from the authenticated user's `AuthContext`. No cross-tenant data leakage is possible — every Prisma `where` clause includes `companyUuid` as a mandatory filter.
