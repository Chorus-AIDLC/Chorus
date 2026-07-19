# Design: Remove from recent (sidebar quick-access)

## Context

The parent feature (`add-sidebar-project-quick-access`) shipped these building blocks,
all of which this change reuses:

- **`ProjectVisit` model** — one row per `(user, project)` with `lastVisitedAt` and a
  nullable `pinnedAt`. `pinnedAt != null` ⇒ pinned; `pinnedAt == null` ⇒ recent-eligible.
- **`project-visit.service.ts`** — `recordVisit`, `pinProject`, `unpinProject`,
  `getSidebarQuickAccess` (filter-then-cap: resolve visits against live company-scoped
  projects, then cap recent at 5). All scoped by `companyUuid + userUuid`.
- **REST** — `GET /api/project-visits` (aggregate), `POST /api/project-visits/visit`,
  `PUT` + `DELETE /api/project-visits/pin`. All human-only (agent → 403).
- **`ProjectQuickAccessProvider`** — the single source of truth mounted once at the
  dashboard shell. `pin` / `unpin` call the pin route, which returns the **fresh
  aggregate**, and replace state in one round-trip so every consumer re-renders with no
  reload. `recordVisit` re-reads after posting.
- **`SidebarProjectQuickAccess` + `QuickAccessRow`** — renders pinned rows first (filled
  pin, always-actionable) then up to 5 recent rows (outline pin, hover/focus-revealed).

## Decisions (from elaboration Round 1)

| # | Decision | Choice |
|---|----------|--------|
| Q1 | Interaction | **⋯ overflow menu** (shadcn `DropdownMenu`) on recent rows |
| Q2 | Semantics | **Soft-remove** — delete the `ProjectVisit` row; no `dismissedAt`, no migration |
| Q3 | Undo toast | **None** — silent remove, no confirm dialog |
| Q4 | Pinned rows | **Keep the direct unpin button** — only recent rows get the ⋯ menu |
| Q5 | Mobile trigger | **⋯ always visible** on mobile (desktop hover/focus-revealed) |

## Backend

### Service: `forgetVisit`

```ts
// src/services/project-visit.service.ts
/**
 * Forget a project's visit for the user — the "remove from recent" action.
 * Deletes the (user, project) ProjectVisit row ONLY when it is not pinned, so a
 * pinned project's state is never lost by a remove. No-op-safe: a missing row or
 * a pinned row deletes zero rows. Scoped by company + user.
 */
export async function forgetVisit(
  companyUuid: string,
  userUuid: string,
  projectUuid: string,
): Promise<void> {
  await prisma.projectVisit.deleteMany({
    where: { companyUuid, userUuid, projectUuid, pinnedAt: null },
  });
}
```

- **Pinned-guard is in the `where` clause** (`pinnedAt: null`), not a read-then-delete —
  atomic, and matches the idempotent style of `unpinProject`.
- Uses `deleteMany` (not `delete`) so an absent row is a zero-row no-op rather than a
  throw — same defensive posture as `unpinProject`'s `updateMany`.
- No `projectInCompany` pre-check needed: the `companyUuid` in the `where` already scopes
  the delete, and deleting a non-existent row is harmless (unlike `recordVisit`/`pin`
  which *create* rows and must reject forged UUIDs).

### Route: `DELETE /api/project-visits`

The bare collection route currently has only `GET`. Add a `DELETE` that mirrors the
pin route's shape — parse + validate `projectUuid`, call `forgetVisit`, then return the
**fresh aggregate** (`getSidebarQuickAccess`) so the provider updates in one round-trip,
exactly like `PUT`/`DELETE /pin`.

```ts
// DELETE /api/project-visits  { projectUuid }  → { success, data:{ pinned, recent } }
export const DELETE = withErrorHandler(async (request) => {
  const auth = await getAuthContext(request);
  if (!auth) return errors.unauthorized();
  if (!isUser(auth)) return errors.forbidden("This operation requires user authentication");
  const body = await parseBody<{ projectUuid?: string }>(request);
  if (!body.projectUuid || body.projectUuid.trim() === "")
    return errors.validationError({ projectUuid: "projectUuid is required" });
  await forgetVisit(auth.companyUuid, auth.actorUuid, body.projectUuid);
  const aggregate = await getSidebarQuickAccess(auth.companyUuid, auth.actorUuid);
  return success(aggregate);
});
```

**Why `DELETE /api/project-visits` (bare collection) and not a new sub-path:** the
resource being deleted is "my visit record for this project." `DELETE` on the
collection with a body identifying the project is consistent with how `/pin` already
takes `{ projectUuid }` in the body for `PUT`/`DELETE`. No new folder needed.

## Frontend

### Provider: `remove`

Add a `remove(projectUuid)` method to `ProjectQuickAccessProvider`, structured exactly
like `unpin` — `DELETE /api/project-visits` with `{ projectUuid }`, and on success
replace `aggregate` with the returned fresh `{ pinned, recent }`. Best-effort error
logging via `clientLogger` (never surfaces to the user), consistent with the siblings.
Expose it on the context value + interface.

### Component: recent rows get the ⋯ menu, pinned rows unchanged

`QuickAccessRow` currently renders a single pin `<Button>` for every row. Split by
`pinnedRow`:

- **Pinned row (`pinnedRow === true`):** unchanged — the existing filled-pin `<Button>`
  that calls `onUnpin`. Always visible (it already is, via `text-primary` with no
  `opacity-0`).
- **Recent row (`pinnedRow === false`):** replace the outline-pin button with a shadcn
  `DropdownMenu`:
  - **Trigger:** a `⋯` (`MoreHorizontal` from lucide) icon `<Button variant="ghost"
    size="icon">`. Desktop: `opacity-0 group-hover:opacity-100
    group-focus-within:opacity-100 focus-visible:opacity-100` (same reveal as the old
    pin button). Mobile (`mobile === true`): always visible (no `opacity-0`).
  - **Items:** `Pin to sidebar` (calls `onPin`) and `Remove from recent` (calls
    `onRemove`). Both with `aria-label`-friendly text; the trigger has an
    `aria-label={t("quickAccess.moreActions", { name })}`.

The `⋯` trigger and menu items must **not** be nested inside the row's `<Link>` (that
would make the whole row a link-with-a-button-inside anti-pattern and swallow clicks).
The current markup already places the action button as a sibling of the `<Link>`, so the
`DropdownMenu` slots into that same sibling position — clicking the kebab opens the menu
without navigating.

Wire `onRemove={remove}` from the provider through `SidebarProjectQuickAccess` →
`QuickAccessRow`, alongside the existing `onPin`/`onUnpin`.

### i18n

Add to all four locales (en / zh / ko / ja), keeping ICU parity (the
`locale-key-parity` AST test enforces identical key sets + placeholders):

| Key | en | zh | ko | ja |
|-----|----|----|----|----|
| `quickAccess.removeFromRecent` | Remove from recent | 从最近移除 | 최근에서 제거 | 最近から削除 |
| `quickAccess.pinToSidebar` | Pin to sidebar | 固定到侧边栏 | 사이드바에 고정 | サイドバーに固定 |
| `quickAccess.moreActions` | More actions for {name} | {name} 的更多操作 | {name} 추가 작업 | {name} のその他の操作 |

(Existing `quickAccess.pin/unpin/pinProject/unpinProject/title` are retained; `pin` and
`unpin` still label the pinned-row button.)

## Theming

`DropdownMenu` (shadcn) already uses semantic tokens (`bg-popover`, `text-popover-
foreground`, `border`), so light + dark work with no extra classes. The `⋯` trigger
reuses `text-muted-foreground hover:text-primary` like the pin button. No hardcoded hex.

## Risks / edge cases

- **Removing a project that is currently open.** Soft-remove only clears recency; the
  user is still on the page, and the next visit-record (or navigation) re-adds it. No
  special handling — acceptable per "zero regret" semantics.
- **Race with visit recording.** If a remove and a `recordVisit` for the same project
  interleave, last-writer-wins on the row; both are idempotent and the aggregate re-read
  reflects the final state. Not a correctness problem.
- **Pinned project via ⋯?** Not possible — pinned rows never render the menu, and
  `forgetVisit`'s `pinnedAt: null` guard means even a forged `DELETE` on a pinned project
  deletes nothing.

## Out of scope

- Hard-hide / "don't show again" (`dismissedAt`) — explicitly rejected in Q2.
- Undo toast / confirm dialog — explicitly rejected in Q3.
- Bulk "clear all recent" — not requested.
- Swipe-to-remove gesture on mobile — rejected in Q5 in favor of the always-visible ⋯.
