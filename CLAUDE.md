# CLAUDE.md — Chorus Project Guide

## What is Chorus

Chorus is an AI Agent & Human collaboration platform implementing the **AI-DLC (AI-Driven Development Lifecycle)** workflow. Multiple AI Agents (PM, Developer, Admin) and humans work together through a shared Idea → Proposal → Document + Task → Execute → Verify → Done pipeline.

Core philosophy: **"Reversed Conversation"** — AI proposes, humans verify (not human prompt → AI execute).

## Tech Stack

- **Framework**: Next.js 15 (App Router, Turbopack for dev)
- **Language**: TypeScript 5 (strict mode)
- **Frontend**: React 19, Tailwind CSS 4, shadcn/ui (Radix UI)
- **Database**: PostgreSQL 16, Prisma ORM 7
- **Cache/Pub-Sub**: Redis 7 (ioredis, optional — falls back to in-memory)
- **Testing**: Vitest 4
- **Auth**: OIDC (users), API Keys with `cho_` prefix (agents), SuperAdmin (env-based bcrypt)
- **MCP**: @modelcontextprotocol/sdk 1.26 (HTTP Streamable Transport)
- **i18n**: next-intl (en, zh)
- **Package Manager**: pnpm 9.15
- **Path alias**: `@/*` → `./src/*`

## Project Structure

```
src/
├── app/                    # Next.js App Router
│   ├── (dashboard)/        # Main app layout (sidebar nav)
│   │   ├── projects/[uuid]/  # Project-scoped pages (tasks, ideas, proposals, docs)
│   │   └── settings/       # Agent API Key management, session management
│   ├── api/                # REST API routes + MCP endpoint
│   │   └── mcp/            # MCP HTTP streaming (POST init, DELETE close)
│   ├── admin/              # SuperAdmin panel
│   └── login/              # OIDC login flow
├── lib/                    # Core utilities (auth, prisma, api-response, uuid-resolver)
├── services/               # Business logic layer (all UUID-based)
├── mcp/                    # MCP Server factory + role-based tool modules
│   ├── server.ts           # Creates per-auth MCP server instance
│   └── tools/              # public.ts, developer.ts, pm.ts, admin.ts, session.ts
├── components/ui/          # shadcn/ui primitives
├── contexts/               # React contexts (locale)
├── i18n/                   # config.ts + request.ts
└── types/                  # TypeScript type definitions (auth.ts)

prisma/
├── schema.prisma           # 21 models, UUID-first architecture
└── migrations/             # DB migrations

messages/
├── en.json                 # English translations
└── zh.json                 # Chinese translations

public/skill/               # MCP Skill documentation served as static files
docs/                       # Architecture, PRD, MCP tools reference, design.pen
packages/chorus-cdk/        # AWS CDK for deployment
```

## Key Commands

```bash
pnpm dev                    # Dev server with Turbopack (:8637)
pnpm build                  # Production build (runs prisma generate first)
pnpm lint                   # ESLint
npx tsc --noEmit            # Type check
pnpm test                   # Run tests (Vitest)
pnpm test:watch             # Run tests in watch mode
pnpm db:migrate:dev         # Create/run dev migration
pnpm db:generate            # Regenerate Prisma client (REQUIRED after schema changes)
pnpm db:push                # Push schema to DB without migration (dev only)
pnpm db:studio              # Prisma Studio GUI (:5555)
pnpm docker:db              # Start PostgreSQL + Redis via Docker
docker compose up -d db     # Start PostgreSQL only (:5433)
```

## Architecture Patterns

### UUID-First

All entities use UUIDs as public identifiers. URLs, API params, and cross-entity references all use UUIDs. Never expose database serial IDs.

### Service Layer

Business logic lives in `src/services/*.service.ts`. API routes and MCP tools both call service functions — never put business logic directly in routes or tools.

### Auth Context

Every request resolves to an `AuthContext` with `type` ("user" | "agent" | "super_admin"), `companyUuid`, and `actorUuid`. The `getAuthContext(request)` function in `src/lib/auth.ts` checks: Bearer token (API Key or OIDC) → Session cookie (user_session / admin_session) → OIDC cookie (oidc_access_token).

Agent auth carries `roles: string[]` (pm_agent, developer_agent, admin_agent) which determines MCP tool visibility.

### Polymorphic Assignment

Tasks and Ideas use `assigneeType` ("user" | "agent") + `assigneeUuid` for flexible assignment to either humans or AI agents.

### MCP Server

The MCP endpoint at `POST /api/mcp` creates per-session server instances. Each session is tied to an authenticated agent. Tools are registered based on the agent's roles. Sessions auto-expire after 30 minutes of inactivity.

Tool registration pattern:
```typescript
server.registerTool("tool_name", {
  description: "...",
  inputSchema: z.object({ /* zod schema */ }),
}, async (params) => {
  const result = await someService.doSomething(auth.companyUuid, ...);
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
});
```

### Agent Sessions (Swarm Mode)

When agents spawn sub-agents (e.g., Claude Code Agent Teams), they create **Sessions** for observability. Lifecycle: `active ↔ inactive (1h no heartbeat) → closed → (reopen) → active`. Sessions checkin/checkout from tasks to track which worker is on which task.

### Activity Stream

`src/services/activity.service.ts` logs all significant actions. Activities support `sessionUuid` + `sessionName` for sub-agent attribution (denormalized for query efficiency).

### Redis (Optional)

Redis is used for SSE event propagation across multiple instances. If `REDIS_URL` is not set, the system falls back to an in-memory EventBus (single-instance only). For production deployments with multiple ECS tasks, ElastiCache Serverless is required.

## Database Notes

- **21 Prisma models**: Company, User, Agent, ApiKey, ProjectGroup, Project, Idea, Document, Task, TaskDependency, AcceptanceCriterion, Proposal, Comment, Activity, AgentSession, SessionTaskCheckin, Notification, NotificationPreference, Mention, ElaborationRound, ElaborationQuestion
- **relationMode = "prisma"**: Prisma handles relations in application code, not DB foreign keys
- **Cascade deletes**: Configured at Prisma level (onDelete: Cascade)
- **After schema changes**: Must run `npx prisma generate` to regenerate client, then restart the dev server to pick up new models. Forgetting this causes `prisma.newModel` to be `undefined` at runtime.

## Testing

Tests use Vitest with coverage thresholds (95% lines, 85% branches). Test files are located in `src/**/__tests__/**/*.test.ts`.

```bash
pnpm test              # Run all tests
pnpm test:watch        # Watch mode
pnpm test:coverage     # Run with coverage report
```

Test mocks are in `src/__mocks__/`. The Prisma client is mocked for all service tests.

## API Response Format

All REST APIs return:
```json
{ "success": true, "data": { ... } }
{ "success": false, "error": "Error message" }
```

Use helpers from `src/lib/api-response.ts`: `success(data)`, `errors.notFound("Entity")`, `errors.badRequest("msg")`, `errors.unauthorized()`, `errors.forbidden("msg")`.

Use `withErrorHandler<T>()` from `src/lib/api-handler.ts` to wrap route handlers for consistent error handling.

## i18n Rules

**CRITICAL: Every user-facing string in the frontend MUST use i18n.** Never hardcode English text directly in JSX — always use `t("key")` and add the key to both locale files. This includes:
- Page titles, subtitles, descriptions
- Button labels, form labels, placeholders
- Error messages, success messages, confirmation dialogs
- Status labels, priority labels, entity type labels
- Relative time strings ("just now", "5 min ago", etc.)

Rules:
- Two locales: `en`, `zh` (messages in `/messages/en.json`, `/messages/zh.json`)
- Always add keys to **both** locale files when adding UI strings
- Use `useTranslations()` hook in client components, `getTranslations()` in server components
- Keys are nested objects: `common.save`, `sessions.reopen`, `activity.taskAssigned`
- Server Components read the locale from the `chorus-locale` cookie (set by `LocaleProvider`). The `src/i18n/request.ts` config reads this cookie — do not hardcode `defaultLocale` there.
- When adding error fallback strings (e.g., `result.error || "Something failed"`), the fallback must also use `t()`: `result.error || t("some.errorKey")`

## Frontend UI Rules

**CRITICAL: Always use shadcn/ui components instead of custom HTML elements.** The project uses shadcn/ui (built on Radix UI) as its component library under `src/components/ui/`. When building UI:
- Use `<Button>`, `<Input>`, `<Label>`, `<Card>`, `<Dialog>`, `<Select>`, `<Table>`, `<Badge>`, etc. from `@/components/ui/*`
- Never write raw `<button>`, `<input>`, `<select>`, `<table>`, or `<dialog>` HTML elements — always use the corresponding shadcn/ui component
- For layout and spacing, use Tailwind CSS utility classes
- If a needed component doesn't exist yet, add it via `npx shadcn@latest add <component>` — do not create custom implementations
- Follow existing component usage patterns in the codebase for consistency

## Skill & Plugin Documentation

Chorus has two sets of skill documentation. **All skill docs must be written in English.**

| Location | Purpose |
|----------|---------|
| `public/skill/` | Standalone skill — served as static assets at `/skill/`, consumed by any agent via curl download |
| `public/chorus-plugin/skills/chorus/` | Plugin-embedded skill — bundled with the Chorus Plugin for Claude Code, includes plugin-specific session automation |

When adding new MCP tools, update:
1. `docs/MCP_TOOLS.md` (internal reference)
2. Relevant skill docs in **both** `public/skill/` and `public/chorus-plugin/skills/chorus/`

MCP tool roles, agent workflows, session management, and AI-DLC lifecycle are all documented in the skill files — not here. Refer to the skill docs for those details.

## Development Conventions

### Update design.pen on Every Feature

When implementing any user-facing feature or UI change, you **must** update `docs/design.pen` to reflect the new or modified screens/components. Use the Pencil MCP tools (`get_editor_state`, `open_document`, `batch_design`, `get_screenshot`, etc.) to read and write `.pen` files — never use Read/Grep directly on `.pen` files as their contents are encrypted.

## Common Pitfalls

1. **Prisma client stale after schema change**: If you modify `prisma/schema.prisma`, you must run `npx prisma generate` AND restart the dev server. The running process caches the old Prisma client in memory.

2. **MCP session expiry**: MCP sessions expire after 30 minutes. The client must handle 404 by reinitializing.

3. **Multi-tenancy**: All queries must be scoped by `companyUuid`. Never return data across company boundaries.

4. **API Key format**: Keys start with `cho_` prefix, followed by base64url-encoded random bytes. Stored as SHA-256 hash in DB. The raw key is shown only once at creation time.

5. **Proposal is a container**: A Proposal holds `documentDrafts` (JSON) and `taskDrafts` (JSON). On approval, these drafts materialize into real Document and Task entities. Don't confuse drafts with actual entities.

6. **Task dependencies form a DAG**: Use `TaskDependency` model. Frontend renders with @xyflow/react + dagre for layout. Circular dependency detection is handled at the service level.

7. **design.pen is encrypted**: The `docs/design.pen` file can only be read/written through the Pencil MCP tools. Never use Read/Grep on `.pen` files.

8. **Server Components vs Client Components**: Default to Server Components. Only add `"use client"` when you need interactivity (useState, useEffect, event handlers). Server Actions (`"use server"`) are used for mutations called from client components.

9. **Cross-platform dependencies only**: This project is published to npm (`@chorus-aidlc/chorus`) and must run on linux-x64, linux-arm64, darwin-x64, darwin-arm64 (Apple Silicon), and Windows. Never add dependencies with native C/C++/Rust bindings (e.g., `bcrypt`, `better-sqlite3`, `sharp`). Always prefer pure JS/WASM alternatives (e.g., `bcryptjs`, PGlite, `@napi-rs/*` with multi-platform prebuilds). Before adding a new dependency, check if it has native bindings — if it does, find a pure JS alternative or ensure it ships prebuilds for all target platforms.

10. **Plugin shell scripts must be Bash 3.2 compatible**: macOS ships with Bash 3.2 (`/bin/bash`) and Claude Code uses it to run hooks. Do NOT use Bash 4+ features in `public/chorus-plugin/bin/*.sh`. Common traps: `${VAR,,}` (use `tr '[:upper:]' '[:lower:]'`), `${VAR^^}` (use `tr '[:lower:]' '[:upper:]'`), `declare -A` (associative arrays), `readarray`/`mapfile`, `|&`, `&>>`. Run `/bin/bash public/chorus-plugin/bin/test-syntax.sh` on macOS to verify.
