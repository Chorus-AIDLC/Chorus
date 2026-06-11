# Proposal: Superadmin vs regular-user login choice on email collision

## Why

When `SUPER_ADMIN_EMAIL` is configured to the same address as a registered regular user — most commonly in local dev, where developers set `DEFAULT_USER` to their own email and also list that email as the superadmin — the login flow gives the superadmin no reliable way in.

Two concrete failures in the current code:

1. **`identify()` resolves only the first matching role.** `POST /api/auth/identify` checks `super_admin → default_auth → oidc` with early returns (`src/app/api/auth/identify/route.ts`). An email that matches more than one auth path collapses to whichever check runs first. The response type union (`IdentifyResponse` in `src/types/admin.ts`) has no way to express "this email maps to multiple roles."

2. **The default-auth form bypasses `identify()` entirely.** When `DEFAULT_USER` + `DEFAULT_PASSWORD` are set, `src/app/login/page.tsx` renders the default-auth password form first (`showDefaultAuthForm`) and submits straight to `/api/auth/default-login`. If the entered email is *also* the superadmin, the regular-user password fails (the two passwords differ) and there is **no UI affordance** to reach `/login/admin`. The only path to the picker — the small "SSO" link — itself routes through `identify()`, which (per failure 1) early-returns `super_admin` or `default_auth` and never offers a choice.

The idea's expected behavior is explicit: when an email matches both superadmin and a regular-user path, present the user a choice — "Sign in as Superadmin" vs "Sign in as regular user" — and route each to its own existing authentication flow.

## What Changes

- **`identify()` collects all matching roles instead of early-returning.** It evaluates superadmin, default-auth, and OIDC-candidate matches, then:
  - **0 paths** → `not_found` (unchanged).
  - **exactly 1 path** → the existing single-match shape (`super_admin` / `default_auth` / `oidc`) (unchanged).
  - **2+ OIDC companies and no superadmin/default-auth** → existing `oidc_multi_match` (unchanged — preserves the current company-picker contract and its tests).
  - **any collision involving superadmin or default-auth** → new `multi_role` response carrying a `roles[]` array, one entry per available auth path.
- **New `multi_role` response type** on `IdentifyResponse`, mirroring the existing `oidc_multi_match` precedent. Each `roles[]` entry has a `kind` (`super_admin` | `default_auth` | `oidc`) and, for OIDC, the company payload the frontend needs to start `signinRedirect`. Backward compatible: single-match callers see no change.
- **`check-default` reports the collision up front.** `GET /api/auth/check-default` adds a `superAdminCollision` boolean (`true` iff default auth is enabled and the configured `DEFAULT_USER` equals `SUPER_ADMIN_EMAIL`, case-insensitive). This lets the login page surface the role choice *before* the prominent default-auth form traps the superadmin.
- **Login page renders a role-picker card on collision.** Built from existing shadcn/ui `Card` + `Button`. Two routes are wired to the existing flows, unchanged:
  - **Superadmin** → `router.push('/login/admin?email=…')` (bcrypt + `admin_session`).
  - **Regular user** → the default-auth password form (`/api/auth/default-login`, `user_session`) or, for OIDC roles, `signinRedirect`.
  The picker is triggered two ways: (a) up front when `check-default` reports `superAdminCollision`, and (b) when `identify()` returns `multi_role` from the SSO/email path.
- **No authentication-endpoint changes.** `/api/admin/login` and `/api/auth/default-login` already authenticate independently (distinct passwords, distinct cookies). Only role *detection* (`identify`, `check-default`) and frontend *routing* change. Cookie and session semantics are untouched.

## Capabilities

### New Capabilities

- `login-role-resolution`: how the login flow resolves an email that maps to more than one authentication path — the `identify()` multi-role contract, the `check-default` collision signal, and the login-page role-picker that routes each choice to its existing auth flow.

## Impact

- **Backend code**: `src/app/api/auth/identify/route.ts` (collect-all-roles logic), `src/types/admin.ts` (`multi_role` type + `IdentifyRoleOption`), `src/app/api/auth/check-default/route.ts` (`superAdminCollision` field). No change to `src/lib/super-admin.ts` or `src/lib/default-auth.ts` beyond reuse of their existing exported predicates.
- **Frontend code**: `src/app/login/page.tsx` — role-picker rendering + routing for both the `multi_role` response and the `superAdminCollision` up-front case. `/login/admin` and the default-auth form are reused unchanged.
- **i18n**: new keys in `messages/en.json` and `messages/zh.json` for the role-picker (title, "Sign in as Superadmin", "Sign in as regular user", per-company OIDC label).
- **Tests**: extend `src/app/api/auth/identify/__tests__/route.test.ts` with the collision matrix (multi_role) plus backward-compat assertions for every existing single-match shape; add `check-default` collision tests. Project coverage thresholds (95% lines / 85% branches) apply.
- **Schema**: zero migrations. No Prisma change.
- **Backward compat**: fully additive on the response contract. Existing `super_admin` / `default_auth` / `oidc` / `oidc_multi_match` / `not_found` responses are byte-identical for non-colliding emails; `check-default` gains one field and keeps `enabled`.
- **Docs**: `docs/design.pen` gains the login role-picker screen state.
- **Runtime**: no new dependencies, no new env vars, no new permissions.
