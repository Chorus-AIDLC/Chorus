# Design: self-service display names

## Decisions and contracts
- Canonical visible value remains `User.name`, keeping existing readers compatible. Add `nameCustomized Boolean @default(false)` with a non-destructive SQL migration. A self-save atomically writes name and the flag. Existing rows retain all data and start false.
- Shared client-safe `src/lib/display-name.ts` exports `DISPLAY_NAME_MAX_LENGTH = 32`, `displayNameLength(value)` (code points after trim), and `displayNameSchema` (Zod string trim then 1–32 code points). No NFC normalization or grapheme counting. Invalid encodings/DB-incompatible NUL must fail with a validation error, never an internal database error.
- `PATCH /api/users/me/name` accepts strictly `{name: string}`; returns the established envelope `{success:true,data:{user:{uuid,name}}}`. Server derives actor/tenant exclusively from authenticated context. Require ordinary user auth, trusted Origin following avatar route, active/non-deleted same-company target; reject missing auth (401), agents/superadmin (403), bad origin (403), malformed/extra-field/invalid payload (400), absent target (404). Do not accept actor/tenant overrides.
- Name service repeats shared validation before atomically updating the scoped row. No email, username, OIDC subject, avatar or privilege changes.
- OIDC synchronization must retain behavior for never-customized users while preserving explicit customization for both existing-subject and existing-email linking paths. Name synchronization uses a database write predicate `nameCustomized:false`, not a stale read-only check. Identity/email updates remain separate from conditional name updates; re-read the user after updates so login responses use persisted name. Tests cover delayed OIDC sync after self-save and normal OIDC sync.
- `/api/session` and subsequent user resolutions must return database name rather than stale token claims (inspect and retain existing behavior where already correct).
- Add `applySavedName(userUuid,name)` to auth context. Track name-save revision independently of avatar revision so a session probe started before a save cannot replace the new name, nor a name save corrupt avatar behavior. Ignore acknowledgements for another user. Settings card validates returned user UUID/name, disables duplicate saves, retains draft on failure, displays localized success/error and trimmed code-point count, and updates auth context only after success. No native maxlength=32 because it counts UTF-16.
- Four existing locale dictionaries get matching keys. Accessible input label, hint/counter, invalid state and live status. Settings page positions this card next to avatar settings. Existing legacy >32 names remain readable but require correction to save; no automatic truncation.

## Implementation boundaries
One cohesive Chorus task covers the feature. Backend/schema/OIDC work and frontend/auth-context/localization work can be implemented in disjoint file sets under the same task. Approved documents and this contract govern both.

The requester explicitly waived `docs/design.pen` for this change through the 2026-10-19 human instruction “豁免design.PEN”. Pencil MCP is unavailable in this session. This exception does not waive the textual design, accessibility, or light/dark theme verification. Use semantic theme tokens and verify the editor in both themes.

## Verification
- Shared validator: empty/whitespace, trim/internal spaces, 1/32/33 code points, astral emoji versus UTF-16, multi-code-point emoji and combining sequences, invalid types/encodings.
- Service/route: tenant and actor binding, inactive/deleted users, denied principal/origin, invalid JSON/extra fields, DB writes only to name+flag, OIDC ordinary/customized/linking/concurrent paths.
- UI/context: valid save and count, invalid input, legacy data, pending/failure states, response validation, stale session refresh, wrong-user acknowledgement and avatar independence.
- Additive migration verified against a disposable PGlite database; targeted tests, typecheck and lint. Real-browser settings verification uses local test identity and records evidence without exposing credentials. Run broader tests when practical; record unrelated baseline failures explicitly.

## Rollout and risks
Apply migration before running the updated server and regenerate Prisma client. No destructive backfill. Rollback code can leave the additive column in place; old code would resume OIDC overwrites, so rollback must account for that behavior. Limits deliberately do not change unrelated admin/invitation rules. Browser code-point counting and server counting share implementation to prevent drift. Runtime test infrastructure failure must be reported rather than marked passed.
