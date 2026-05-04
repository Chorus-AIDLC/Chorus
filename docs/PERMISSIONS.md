# Agent Permissions

This document explains Chorus's agent authorization model — what permissions exist, how they're assigned, and how they gate access at every layer (REST, MCP, UI).

> **When you need this doc**: creating an Agent, writing custom permission combinations, debugging "why can't my agent call this tool", or designing a new endpoint that needs gating. For the broader auth story (OIDC, API Keys, cookies, SuperAdmin), see [AUTH.md](./AUTH.md). For human/admin operational permissions in the web UI, see [ARCHITECTURE.md §6](./ARCHITECTURE.md#6-authentication--authorization).

---

## 1. The 5 × 3 Matrix

Every Agent carries a **permission set** — a subset of 15 permission bits drawn from a 5 × 3 grid:

|  | `read` | `write` | `admin` |
|---|---|---|---|
| **`idea`** | view ideas | create / claim / release / update ideas; run elaboration rounds | close / delete ideas |
| **`proposal`** | view proposals and drafts | create / submit / reject / revoke proposals; manage drafts; batch-create tasks; manage task DAG; assign tasks | approve / close proposals |
| **`document`** | view documents | create / update documents | delete documents |
| **`task`** | view tasks | claim / release / submit / report tasks; self-check acceptance criteria | verify / reopen / close / delete tasks; mark acceptance criteria |
| **`project`** | view projects and project groups | create / update / delete projects and project groups; move projects between groups | granted by the `admin_agent` preset but currently not gated by any tool or route (reserved — treat as forward-compatibility) |

A permission is written as `{resource}:{action}` — for example `task:write` or `proposal:admin`.

Action semantics are cumulative by convention but **not automatically inherited**. Granting `task:admin` does **not** imply `task:read` or `task:write` — each bit must be granted explicitly. The three presets below do grant the expected read/write prefix, so in practice this only matters when you build a custom permission set.

---

## 2. Role Presets

The UI ships three named presets that expand to a fixed permission set. They exist so common agent shapes stay one click away; they are **not** a separate authorization mechanism. Under the hood, a preset is just a shortcut for a specific subset of the 15 bits.

| Preset | Expanded Permissions | Count | Typical Use |
|---|---|:---:|---|
| `developer_agent` | `*:read` + `task:write` | **6** | Executes tasks, reports work, submits for verification |
| `pm_agent` | `*:read` + `idea:write` + `proposal:write` + `document:write` + `task:write` + `project:write` | **10** | Runs elaboration, drafts proposals, decomposes tasks |
| `admin_agent` | all 15 bits (`*:read` + `*:write` + `*:admin`) | **15** | Proxies human approval: verifies tasks, approves proposals, deletes entities |

The authoritative mapping lives in `src/lib/authz/presets.ts`.

> ⚠️ `*:admin` permissions are **human-level**. They cover proposal approval, task verification, and entity deletion — actions that normally require a human reviewer. Grant them only to agents that intentionally automate approval workflows.

### The `Custom` option

Any Agent can layer additional permission bits on top of (or instead of) a preset. The UI calls this **Custom**; the API calls it `permissions[]` on the Agent record. Common combinations:

- **Read-only auditor**: no preset, custom = `*:read` only → can list and inspect everything, cannot mutate.
- **Self-verifying developer**: `developer_agent` preset + `task:admin` → can verify tasks without waiting for an admin. Note that `task:admin` is not author-scoped — it lets the agent verify any task in its company, not just ones it worked on.
- **PM with admin approval**: `pm_agent` preset + `proposal:admin` → can approve proposals (any proposal, not only its own — admin bits don't distinguish author from reviewer, so this effectively bypasses human review across the whole pipeline).

---

## 3. Effective Permissions

An Agent's **effective permission set** is what actually decides what the agent can do. It's computed once per request and threaded through the auth context.

```typescript
// src/lib/authz/permissions.ts
computeEffectivePermissions(
  roles,             // e.g. ["developer_agent"]
  customPermissions, // e.g. ["task:admin"]
): Set<Permission>
```

The function returns the **union** of:

1. Every preset named in `roles[]`, expanded via `ROLE_PRESETS`.
2. Every entry in `customPermissions[]` that passes `isValidPermission` (invalid strings are silently dropped — see `src/lib/authz/permissions.ts`).

Order of precedence doesn't matter — it's pure set union. Legacy role names (`pm`, `developer`, `admin`) are normalized to their `_agent` form and resolve to the same presets.

### Example

An Agent with `roles: ["pm_agent"]` and `permissions: ["task:admin"]` has:

```
{ *:read } ∪ { idea:write, proposal:write, document:write, task:write, project:write } ∪ { task:admin }
= 11 permissions total
```

---

## 4. How Permissions Gate Access

### 4.1 MCP tool visibility

Each permission-gated MCP tool declares **exactly one** required permission. The mapping lives in `src/mcp/tools/permission-map.ts`.

- At registration time, `registerPermissionedTool` (in `src/mcp/tools/register-helpers.ts`) checks whether the agent's effective set contains the tool's required permission. If yes, the tool is registered on the MCP server; if no, it's simply absent from the tool list the agent sees.
- **Public tools** (`chorus_checkin`, `chorus_get_*`, `chorus_list_*`, `chorus_search*`, `chorus_add_comment`, session tools, `chorus_create_tasks`, `chorus_update_task`) have no permission gate — they appear for every agent. Two caveats worth spelling out:
  - `chorus_update_task` allows field edits (title, description, priority, etc.) for any agent, but **status transitions** (`in_progress`, `to_verify`) are restricted to the task's assignee via a handler-level check (`src/mcp/tools/public.ts`).
  - `chorus_create_tasks` has **no handler-level guard** — any authenticated agent can batch-create tasks in any project of its company. If you need tighter control (e.g. only PMs create tasks), treat that as a follow-up and add a permission gate on this tool.

For the full tool → required-permission matrix, see [MCP_TOOLS.md](./MCP_TOOLS.md).

### 4.2 REST API gating

REST routes use a decorator factory:

```typescript
// src/lib/auth.ts
export const POST = requireAgentPermission("task:admin", async (req, ctx, auth) => {
  /* auth.type is "agent" or "super_admin" here */
});
```

- If the caller is an **Agent** without the required permission → `403 Missing permission: task:admin`.
- If the caller is a **human User** → `requireAgentPermission` does **not** apply; human routes use `requireUser` or cookie-based auth instead.
- **SuperAdmin** bypasses all permission checks (`hasPermission` short-circuits `true`).

For routes that serve both humans and agents, use `checkAgentPermission(ctx, permission)` inside the handler — it returns `null` for users / super_admins and a 403 `NextResponse` for agents missing the bit.

### 4.3 In-handler checks

For ad-hoc checks (e.g. inside a service function where you already have the auth context):

```typescript
import { hasPermission } from "@/lib/auth";

if (isAgent(auth) && !hasPermission(auth, "proposal:admin")) {
  throw new Error("need proposal:admin");
}
```

Don't use `hasRole(auth, "pm")` in new code. It still works as a back-compat shim but it asks the wrong question — ask about permissions, not presets.

---

## 5. The Agent Record

The `Agent` Prisma model carries two relevant columns:

| Column | Type | Meaning |
|---|---|---|
| `roles` | `string[]` | **Preset selector** — one or more of `developer_agent` / `pm_agent` / `admin_agent`. Legacy `pm` / `developer` / `admin` aliases are accepted and normalized. |
| `permissions` | `string[]` | **Custom permission bits** layered on top of the preset(s). Plain `resource:action` strings. Added in the 0.7.0 migration (`prisma/migrations/.../add_agent_permissions`). |

API Keys do not carry their own permission state — each key inherits its Agent's permissions at authentication time (`src/lib/api-key.ts` → `validateApiKey`). Rotating a key doesn't change permissions; editing the Agent does.

### Checkin output shape

`chorus_checkin` returns permissions in a **resource-aggregated** shape, not a flat array. This is deliberate: it's compact (every resource listed once, not five times), stable (actions are sorted in canonical order), and easy for skills / plugin hooks to consume:

```json
{
  "agent": {
    "uuid": "...",
    "name": "My PM Agent",
    "permissions": {
      "idea":     ["read", "write"],
      "proposal": ["read", "write"],
      "document": ["read", "write"],
      "project":  ["read"],
      "task":     ["read", "write"]
    }
  }
}
```

Resources with zero granted actions are omitted from the object (so a pure `*:read` agent sees five one-element arrays; a truly scoped agent might see only two or three keys). The aggregation helper is `groupPermissionsByResource` in `src/lib/authz/permissions.ts`.

---

## 6. UI Surface

The permission picker appears in three places, all sharing one component (`src/components/AgentFormFields.tsx` → `AgentPermissionPicker`):

1. **Onboarding** — first-time users pick a preset while creating their initial Agent.
2. **Settings → Agents → Create** — creating a new Agent.
3. **Settings → Agents → Edit** — editing an existing Agent.

The picker renders the 5 × 3 grid with a preset selector on top. Clicking a preset fills the grid; any checkbox toggle that diverges from the preset flips the selector to **Custom** automatically. The Admin column (`*:admin`) is always interactive — toggling it on a preset doesn't lock the form, it just shifts to Custom with the admin bit included.

---

## 7. Designing New Endpoints

When you add a new MCP tool or REST route, decide on the right permission bit up front:

1. **Is this a read?** → `{resource}:read`.
2. **Does it mutate normal-course state** (claim a task, report work, edit a doc)? → `{resource}:write`.
3. **Does it substitute for human judgment** (approve, verify, delete)? → `{resource}:admin`.

Then:

- **MCP tool**: add an entry to `src/mcp/tools/permission-map.ts` and register with `registerPermissionedTool`. The `permission-map.ts` test suite (`src/mcp/__tests__/server.test.ts`) enforces that every non-public tool is listed.
- **REST route**: wrap the handler with `requireAgentPermission(permission, handler)`. If the route serves humans and agents, use `checkAgentPermission` inside instead.
- **Service layer**: service functions generally don't gate on permissions themselves — they trust that the route or tool layer already gated. Exception: additional ownership / assignee / status guards (e.g. "only the assignee can submit for verify") live at the service layer and run **after** the permission gate.

---

## 8. Source of Truth

| Concept | File |
|---|---|
| Permission types (`Resource`, `Action`, `Permission`, `ALL_PERMISSIONS`) | `src/lib/authz/types.ts` |
| Role preset → permission set mapping | `src/lib/authz/presets.ts` |
| `computeEffectivePermissions`, `groupPermissionsByResource` | `src/lib/authz/permissions.ts` |
| `hasPermission`, `requireAgentPermission`, `checkAgentPermission` | `src/lib/auth.ts` |
| MCP tool → required-permission map | `src/mcp/tools/permission-map.ts` |
| `registerPermissionedTool` | `src/mcp/tools/register-helpers.ts` |
| UI picker | `src/components/AgentPermissionPicker.tsx`, `src/components/AgentFormFields.tsx` |
| Migration that added `permissions` column | `prisma/migrations/*_add_agent_permissions/` |

If any of the above drift from this doc, update the doc — the code is authoritative.
