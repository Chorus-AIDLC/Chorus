# Technical Design: Daemon-connect empty-state CTA

## Overview

A purely-presentational shared component, `DaemonConnectCta`, is added to the agent-presence vocabulary and rendered in three empty-state surfaces. There is no data fetching, no backend, no schema work. The only "logic" is: render the CTA when there are 0 online connections (the two presence surfaces already know this from `useAgentPresence()`), and on the onboarding completion screen render it unconditionally as the next step.

## Architecture

### Single source of truth for the command

The command shown to users is the `npx` zero-install form. It is defined **once** as an exported constant, not inlined at each call site:

```ts
// src/components/agent-presence/daemon-connect-cta.tsx (or a small co-located consts module)
export const DAEMON_NPX_PACKAGE = "@chorus-aidlc/chorus";
export const DAEMON_START_COMMAND = `npx ${DAEMON_NPX_PACKAGE} daemon`;
export const DAEMON_LOGIN_COMMAND = `npx ${DAEMON_NPX_PACKAGE} login`;
```

Rationale (idea owner's instruction): the CLI will be published to npm; the target user has installed nothing, so `npx` is the most copy-paste-runnable. Verified against the current CLI: `chorus.mjs` declares bin `chorus` for package `@chorus-aidlc/chorus`, with subcommands exactly `daemon` and `login`; `daemon` resolves credentials by flag > env > `~/.chorus/daemon.json` (written by `login`) > plugin fallback. So a first-time user runs `login` then `daemon`.

i18n messages carry **only** the surrounding prose (headline, body, button labels, link text) — never the command literal. A future package/bin rename changes one constant and all three surfaces follow.

### `DaemonConnectCta` component contract

```ts
type DaemonConnectCtaVariant = "compact" | "prominent";

function DaemonConnectCta({ variant }: { variant: DaemonConnectCtaVariant }): JSX.Element
```

- `compact` — used in the sidebar pill popover (narrow, ~360px). Tighter spacing, single primary command (`DAEMON_START_COMMAND`) with a copy button; the `login`-first note and "Learn more" link are condensed.
- `prominent` — used in the onboarding completion screen (and acceptable in the wider Agent Connections modal). A framed "Next step" card with headline, body emphasizing "plugin installed ≠ resident online," the command + copy, the first-run `login` note, and the "Learn more" link.

The component:
- renders the command inside a monospace, copyable surface. **Reuse** the existing copy affordance pattern. The onboarding flow already has `src/components/install-guide/CodeBlock.tsx` (renders fenced code via `MarkdownContent`) — but it has no explicit copy button. For an explicit one-click copy with a "Copied" confirmation, add a small copy button using the browser Clipboard API (`navigator.clipboard.writeText`) with a transient copied state, consistent with how the codebase already triggers clipboard writes. Use shadcn `Button` + a lucide `Copy` / `Check` icon swap.
- exposes the "Learn more" link to the onboarding install guide. On the completion screen this routes within the onboarding flow; on the pill/modal (dashboard shell) it links to the onboarding install guide route. Use the existing onboarding route already used by the wizard rather than inventing a new path; if no standalone install-guide route exists, link to `/onboarding` (or the settings agent-key area that embeds `AgentInstallGuide`).
- is `"use client"` (uses `useTranslations` + clipboard + local copied state) and fetches nothing.

### Surface wiring

1. **Pill popover** (`agent-presence-pill.tsx`, `PopoverBody`): the `onlineConnections.length === 0` branch currently returns `<p>{t("popoverEmpty")}</p>`. Replace with `<DaemonConnectCta variant="compact" />`. The popover already only renders online connections, so this branch *is* the 0-online state; nothing else gates it. The pill trigger itself stays unchanged (it must remain visible at 0 online per the existing no-silent-error rule).

2. **Onboarding completion** (`CompletionStep.tsx`): insert a `DaemonConnectCta variant="prominent"` block between the summary card and the action buttons. The existing "Go to projects / settings" buttons remain. This is the only surface where the CTA shows regardless of connection state (the user just finished onboarding and by definition has nothing connected yet).

3. **Agent Connections modal empty state** (`connections-view.tsx`): the `connections.length === 0` branch currently renders a `Card` with `RadioTower` icon + `empty.title` + `empty.body`. Keep the card framing/icon/title; replace the hand-written `empty.body` command sentence with `<DaemonConnectCta variant="prominent" />` (or fold the body into the shared CTA). The distinct **error** state (`showError`) is untouched — no-silent-error contract preserved.

### Why a shared component, not three copies

The Agent Connections empty state already ships a near-identical sentence. Three independent copies drift (one says "Run `chorus daemon`", another might say "run the daemon", a third the npx form). One component + one command constant guarantees the three surfaces stay byte-identical in command and consistent in prose, and a command change is a one-line edit.

## Data Model

None. No Prisma/schema/migration changes.

## API Design

None. No new endpoints; no calls to existing ones. The CTA is static.

## Module Contracts

- **Command constants** (`DAEMON_START_COMMAND`, `DAEMON_LOGIN_COMMAND`, `DAEMON_NPX_PACKAGE`) are the single source of truth, exported from the CTA module and re-exported from the `src/components/agent-presence/index.ts` barrel if any other surface needs them.
- **`DaemonConnectCta`** is exported from the `agent-presence` barrel (`index.ts`) alongside the other shared vocabulary (`StatusDot`, `IdentityBlock`, etc.), so all three call sites import from `@/components/agent-presence`. It takes only `{ variant }` and never reads `useAgentPresence()` itself — the *caller* decides whether to render it.
- **i18n keys**: the CTA reads from a single namespace (extend `agentConnections` for the CTA prose, since it already owns the empty-state copy, OR a small new `daemonConnectCta` group — pick one and use it for all three surfaces). The completion-screen-specific framing ("plugin installed ≠ online") may be a separate key under `onboarding.completion` passed in as the `prominent` body, OR carried by the shared namespace; keep the command-bearing prose in the shared namespace either way. Every new key is added to **both** `en.json` and `zh.json`.
- **Copy interaction + IME**: the copy button is a click affordance, not an Enter-submit handler, so the CLAUDE.md IME-composition guard does not apply. If any Enter-to-copy keyboard handler is added, route it through `isImeComposing` from `@/lib/ime`.

## Implementation Plan

1. Add `DaemonConnectCta` + the command constants; export from the barrel. Add i18n keys (en + zh). Reuse/extend the copy affordance.
2. Wire the three surfaces (pill popover empty branch, completion screen block, connections-view empty branch); remove the now-redundant `popoverEmpty` usage and reconcile `agentConnections.empty.body`.
3. Update `docs/design.pen` for the three mocks; verify in a real browser (e2e) that the pill popover at 0-online and the onboarding completion screen show the CTA with a working copy button, and the Agent Connections empty state matches.

## Risks & Mitigations

- **`npx` form correctness** — the package name / bin / subcommands were verified against `chorus.mjs` at design time, but the developer must re-verify against the CLI source at implementation time (don't trust LLM memory for the exact package string), since the npm publish name could change before release. Mitigation: the AC requires verifying the command against `chorus.mjs` / `package.json`.
- **"Learn more" link target** — there may not be a standalone install-guide route outside the onboarding wizard. Mitigation: link to the existing onboarding route (`/onboarding`) or the settings surface that embeds `AgentInstallGuide`; the developer picks the real existing route rather than inventing one, and the AC calls this out.
- **i18n namespace choice** — extending `agentConnections` vs. a new `daemonConnectCta` group is a judgment call; either is fine as long as **one** namespace is used across all three surfaces and both locales are updated. Mitigation: AC requires a single namespace + both locales.
- **Clipboard API availability** — `navigator.clipboard` requires a secure context; in dev over plain HTTP on non-localhost it can be undefined. Mitigation: guard the write (no-throw) and still show the command text so copy failure degrades gracefully (no silent crash).
