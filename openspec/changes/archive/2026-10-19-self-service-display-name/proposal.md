# Self-service display names

## Why
Users need to control their displayed name independently of login identifiers. The human selected settings-page editing, persistent overrides for OIDC users, and a trimmed length of 1–32 Unicode code points.

## What Changes
- Add a self-only display-name update API and settings card beside the avatar settings.
- Share trim and code-point validation between browser and server; allow Unicode and internal spaces, reject empty or overlength submissions, without requiring unique names.
- Persist explicit customization so future OIDC sign-ins cannot overwrite a saved display name, including concurrent sign-in/update races.
- Update current authenticated UI immediately on successful save, preserve input on failure, and load the persisted name on subsequent requests.
- Retain existing names without truncation. New limits apply to self-service saves, not existing invitations/admin editing or untouched OIDC profiles (YOLO elaboration round 2).

## Capabilities
### New Capabilities
- `self-service-display-name`: authorized self-editing, Unicode validation, OIDC override persistence and accessible localized settings.

## Impact
User schema additive migration, user/OIDC services, self-profile route, auth context, settings UI, four locale dictionaries, and regression tests.

## Out of Scope
Login usernames/emails/identifiers, unique names, name reset to identity-provider defaults, agent/superadmin profiles, bulk renaming, historical snapshot rewriting, and real-time cross-client updates. No push or PR merge is authorized.

## Evidence
Existing Idea research is reused: native maxlength counts UTF-16 rather than the chosen Unicode code points, and browser checks cannot replace server validation ([MDN](ref:deb392fe-ff13-4406-963f-0f91bdc9c609)). No new external research is required.
