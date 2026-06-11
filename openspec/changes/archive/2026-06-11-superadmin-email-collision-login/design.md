# Design: Superadmin vs regular-user login choice on email collision

## Context

Three auth paths can each claim an email at login time:

| Path | Predicate (existing) | Authenticator | Cookie |
|---|---|---|---|
| Superadmin | `isSuperAdminEmail(email)` (`src/lib/super-admin.ts`) | `/api/admin/login` (bcrypt vs `SUPER_ADMIN_PASSWORD_HASH`) | `admin_session` |
| Default auth | `isDefaultAuthEnabled() && email === getDefaultUserEmail()` (`src/lib/default-auth.ts`) | `/api/auth/default-login` (plaintext vs `DEFAULT_PASSWORD`) | `user_session` |
| Company OIDC | `companyService.getCandidateCompaniesForEmail(email)` returns ≥1 | OIDC `signinRedirect` | OIDC tokens |

These predicates are independent and can all be true for one email. The current `identify()` only reports the first; the current login page sometimes never calls `identify()` at all. This design makes role *resolution* exhaustive and routes the choice to the user, while leaving each *authenticator* untouched.

## Goals / Non-goals

**Goals**
- Detect every auth path an email maps to, and when 2+ involve superadmin or default-auth, let the user pick.
- Keep the response contract backward compatible: non-colliding emails get byte-identical responses.
- Surface the choice even on the default-auth-first screen (the real-world trap).

**Non-goals**
- No change to how any path authenticates (passwords, cookies, token lifetimes).
- No unification of `/api/admin/login` and `/api/auth/default-login`.
- No new env vars, no schema migration.

## Decision 1 — `identify()` collects roles, then branches on count

Replace the three early-return blocks with a collection pass:

```ts
type ResolvedRole =
  | { kind: "super_admin" }
  | { kind: "default_auth" }
  | { kind: "oidc"; company: { uuid; name; oidcIssuer; oidcClientId } };

const roles: ResolvedRole[] = [];
if (isSuperAdminEmail(email)) roles.push({ kind: "super_admin" });
if (isDefaultAuthEnabled() && email === getDefaultUserEmail()) roles.push({ kind: "default_auth" });
const candidates = await companyService.getCandidateCompaniesForEmail(email);
for (const c of candidates) roles.push({ kind: "oidc", company: { … } });
```

Then branch on the **shape** of `roles`, preserving every existing response exactly:

| Condition | Response `type` | Notes |
|---|---|---|
| `roles.length === 0` | `not_found` | unchanged (message preserved) |
| only `super_admin` | `super_admin` | unchanged |
| only `default_auth` | `default_auth` | unchanged |
| only OIDC, exactly 1 company | `oidc` (+ full company payload) | unchanged |
| only OIDC, 2+ companies | `oidc_multi_match` (+ candidates, `parseHost`, no clientId leak) | unchanged — keeps current test contract |
| superadmin and/or default-auth present alongside ≥1 other path | **`multi_role`** | new |

The key invariant: `multi_role` is returned **only** when the set of distinct paths is ambiguous in a way the old contract could not express — specifically when superadmin or default-auth coexists with another path. Pure-OIDC multiplicity stays `oidc_multi_match` so its existing frontend handler and tests are untouched.

### `multi_role` payload

```ts
interface IdentifyRoleOption {
  kind: "super_admin" | "default_auth" | "oidc";
  // present only when kind === "oidc": everything the page needs for signinRedirect
  company?: { uuid: string; name: string; oidcIssuer: string; oidcClientId: string };
}
interface IdentifyResponse {
  type: "super_admin" | "oidc" | "oidc_multi_match" | "default_auth" | "multi_role" | "not_found";
  company?: { … };            // oidc
  candidates?: IdentifyCandidate[];   // oidc_multi_match
  roles?: IdentifyRoleOption[];       // multi_role  ← new
  message?: string;
}
```

`super_admin` and `default_auth` role entries carry no secrets (the page just routes to `/login/admin` or the password form). OIDC entries carry the same company payload the single-`oidc` response already exposes, so no new data is leaked relative to today.

## Decision 2 — `check-default` exposes the collision up front

`GET /api/auth/check-default` currently returns `{ enabled }`. The default-auth-first screen is shown purely on `enabled`, so a colliding superadmin sees only the regular-user password form. Add one field:

```ts
return success({
  enabled,
  superAdminCollision: enabled && getDefaultUserEmail() != null
    && isSuperAdminEmail(getDefaultUserEmail()!),
});
```

`superAdminCollision` is `true` iff default auth is on **and** the configured `DEFAULT_USER` is itself the superadmin email. This is a config-level fact (no user input), so it is safe to compute on the unauthenticated `check-default` endpoint — it reveals only that the operator pointed both env vars at the same address, which the operator already knows. It does **not** echo the email back.

## Decision 3 — login page role-picker

`src/app/login/page.tsx` gains a `roleChoices: IdentifyRoleOption[] | null` state and a small picker card (shadcn `Card` + `Button`, all strings via `t()`):

- **Trigger A (up-front collision):** in the existing `checkDefaultAuth()` effect, if `data.superAdminCollision` is true, seed `roleChoices` with `[{kind:'super_admin'}, {kind:'default_auth'}]` so the picker shows instead of dropping straight into the default form. The user can still pick "regular user" to get today's password form.
- **Trigger B (identify multi_role):** in `handleSsoSubmit`, when `result.type === 'multi_role'`, set `roleChoices = result.roles`.

Routing per choice (all reuse existing flows):

| `kind` | Action |
|---|---|
| `super_admin` | `router.push('/login/admin?email=' + encodeURIComponent(email))` |
| `default_auth` | show the existing default-auth password form (clear `roleChoices`, set the default-form branch) |
| `oidc` | `storeOidcConfig(...)` + `createUserManager(...).signinRedirect({ login_hint: email })` — identical to the existing single-`oidc` branch |

The picker labels superadmin and regular-user explicitly; OIDC entries are labeled by `company.name`. A "back" affordance returns to the email/default form.

## Risks & mitigations

- **Risk: breaking the OIDC company-picker contract.** Mitigated by routing pure-OIDC multiplicity to the unchanged `oidc_multi_match` branch; `multi_role` is reserved for superadmin/default-auth collisions. Existing identify tests must keep passing unmodified.
- **Risk: leaking that an email is the superadmin.** `check-default`'s `superAdminCollision` is a pure config flag (both env vars point at one address); it never reflects a user-supplied email and is only `true` in the operator's own deployment. `identify()` already reveals `super_admin` for the superadmin email today, so `multi_role` exposes nothing new.
- **Risk: IME/Enter regressions on the new picker.** The picker is button-driven, no new Enter-submit handler; existing form handlers are unchanged. No `isImeComposing` surface added or removed.

## Migration / rollout

Pure code + i18n + design.pen change. No schema, no env, no data migration. Ships behind no flag — additive response fields are ignored by older clients, and the collision only manifests when an operator has deliberately configured the overlap.
