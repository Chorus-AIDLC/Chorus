---
name: e2e-verification
description: Use when manually verifying a Chorus frontend change in a real browser — finding local login credentials, driving the running dev server with the Playwright MCP, logging in, navigating to a page, and capturing snapshots/screenshots for e2e acceptance.
license: AGPL-3.0
metadata:
  author: chorus
  version: "0.1.0"
  category: testing
---

# E2E Verification (Playwright + local login)

## Overview

Drive the **running** Chorus dev server in a real browser via the Playwright MCP to verify UI changes end-to-end. Core loop: **log in with local credentials → navigate → snapshot to read state / act → screenshot for the human**.

This is manual acceptance, not the automated Vitest suite (`pnpm test`). Use it when an AC says "the user sees X" and only a real browser can confirm it.

## Prerequisites

- **Dev server healthy** on port **8637**. Always check first:
  ```bash
  curl -s -o /dev/null -w "%{http_code}" http://localhost:8637/login   # expect 200
  ```
  If it's not `200` (connection refused, 500, or anything else), the server isn't running or is broken — start it with `pnpm dev:local` and re-check until it returns `200` before driving the browser. (Plain `pnpm dev` works too, but `pnpm dev:local` brings up the full local stack.)
- **Playwright MCP tools available.** They are deferred — load them first:
  `ToolSearch("select:mcp__playwright__browser_navigate,mcp__playwright__browser_snapshot,mcp__playwright__browser_take_screenshot,mcp__playwright__browser_click,mcp__playwright__browser_fill_form")`

## Step 1 — Find credentials

Local dev uses the **default-auth** path (plain email + password on `/login`). Read it from the `.env` file at the repo root:

```bash
grep -E "DEFAULT_USER|DEFAULT_PASSWORD" .env
# DEFAULT_USER="admin@chorus.local"
# DEFAULT_PASSWORD="chorus"
```

`DEFAULT_USER` logs in as a regular workspace user (e.g. `admin@chorus.local`). This is NOT the same as `SUPER_ADMIN_EMAIL` (the `/login/admin` panel) or the Cognito OIDC flow described in the older `.claude/skills/oidc-login.md` — for normal page verification you want default-auth.

## Step 2 — Log in (verified flow)

When default-auth is enabled, `/login` shows the email+password form **directly** (no SSO redirect):

1. `browser_navigate` → `http://localhost:8637/login`
2. `browser_snapshot` → grab the `ref` of the Email box, Password box, and "Sign In" button.
3. `browser_fill_form` with both fields:
   ```
   [{ name: "Email",    target: "<email-ref>",    type: "textbox", value: "admin@chorus.local" },
    { name: "Password", target: "<password-ref>", type: "textbox", value: "chorus" }]
   ```
4. `browser_click` the "Sign In" button.
5. **Success = URL becomes `/projects`.** The tool result echoes `Page URL` — confirm it changed. If it stays on `/login` with an error banner, the credentials or the server's default-auth config are wrong.

Already authenticated from a prior session? The browser keeps the session, so you can skip straight to Step 3. To test the login itself, sign out first: on any dashboard page click the **"Sign out"** button (bottom-left of the sidebar), which returns you to `/login`. (If `/login` already shows the email+password form, you're logged out — there's no "Sign out" button to find; just proceed with Step 2.)

## Step 3 — Navigate & observe

- `browser_navigate` to the target, e.g. a project dashboard:
  `http://localhost:8637/projects/<project-uuid>/dashboard`
- **`browser_snapshot` is the workhorse** — it returns an accessibility tree with stable `ref` ids. Use it to read page state and to get the `ref`/`target` you pass to `browser_click`, `browser_fill_form`, etc. Prefer it over screenshots for *acting*.
- Toggle UI and re-snapshot to compare states (e.g. the dashboard's Ideas/Stats and Flat/Lineage segmented controls each re-render the tree).
- If a navigate returns a near-empty tree, the page is still hydrating — call `browser_snapshot` again.

## Step 4 — Screenshot for the human

Use `browser_take_screenshot` when the human needs to *see* the result (visual layout, spacing, color).

**Always prefix the filename with `.playwright-mcp/`** — that directory is gitignored. A bare `filename: "foo.png"` saves to the **repo root** and pollutes `git status`.

```
browser_take_screenshot({ type: "png", filename: ".playwright-mcp/dashboard-lineage.png" })
```

Then `Read` it to view it inline. The screenshot tool result echoes a **repo-relative** path; `Read` needs an **absolute** one, so read it as `<repo-root>/.playwright-mcp/<name>.png` (prefix the path you passed with the absolute repo root). To capture a single element instead of the viewport, pass its `target` ref (from a snapshot). The MCP also auto-saves snapshot `.yml` and console `.log` files under `.playwright-mcp/`.

## Quick reference

| Need | Tool |
|------|------|
| Go to a URL | `browser_navigate` |
| Read page state / get element refs | `browser_snapshot` |
| Click / type / fill | `browser_click`, `browser_type`, `browser_fill_form` |
| Visual capture for the human | `browser_take_screenshot` → `.playwright-mcp/<name>.png` |
| Check console errors | `browser_console_messages` |

## Common mistakes

| Mistake | Fix |
|---------|-----|
| Calling `browser_*` before loading schemas | `ToolSearch("select:mcp__playwright__browser_...")` first; bare calls fail with InputValidationError. |
| Screenshot with bare filename | Prefix `.playwright-mcp/` or it lands in repo root (not gitignored). |
| Following the old `oidc-login.md` (Cognito) for local dev | Local dev = default-auth (`.env` `DEFAULT_USER`/`DEFAULT_PASSWORD`) → `/api/auth/default-login` → `/projects`. |
| Acting on coordinates from a screenshot | Screenshots aren't actionable; get `ref`s from `browser_snapshot`. |
| "Login failed" but credentials look right | Confirm dev server is up on 8637 and `Page URL` actually moved off `/login`. |
| `find`-ing for a saved screenshot across the FS | It's already at the `.playwright-mcp/<name>.png` you passed; just `Read` it. |
