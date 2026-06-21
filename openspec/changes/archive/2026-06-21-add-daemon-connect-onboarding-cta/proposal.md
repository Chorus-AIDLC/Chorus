# Proposal: Empty-state CTAs guiding users to run the `chorus daemon`

## Why

The parent idea (`f2fe9a7f` — Daemon connection observability) shipped the full "watch your connections" surface: the bottom-left agent-presence pill, its popover, the Agent Connections "View all" modal, and chat-style daemon sessions. But all of that is only populated **once a daemon is already connected**. For a user who has never run `chorus daemon`, the platform barely hints that they need to start a long-lived local daemon for an agent to actually be online and do work. That is a **discoverability gap**.

Concretely, at the two moments a user is most likely to notice "I'm not connected," the UI is a dead end:

1. **Bottom-left agent-presence pill, 0-online empty state** (`src/components/agent-presence-pill.tsx`). When no agent is online, opening the popover renders only `agentPresence.popoverEmpty` = "No agents are online right now." — a bare statement with **no guidance on how to bring an agent online**.

2. **Onboarding completion screen** (`src/app/onboarding/components/CompletionStep.tsx`, the 6-step wizard's final step). It shows a success icon, an agent summary card, and two navigation buttons ("Go to projects" / "Go to settings"). The wizard's middle steps cover installing a plugin (`InstallGuideStep`) and testing a one-shot connection (`TestConnectionStep`), but the completion screen never explains that **installing a plugin ≠ a resident online agent — you must run `chorus daemon` to keep a long-lived connection so the agent auto-receives dispatched work**.

A third surface, the **Agent Connections modal empty state** (`src/components/agent-presence/connections-view.tsx`), *already* carries guidance text (`agentConnections.empty.body`: "Start a daemon to connect an agent to Chorus. Run `chorus daemon`…"). So that surface is partially covered — the risk is text drift across three places that say almost-the-same thing differently.

This change turns the two dead-end empty states into **calls to action**, and unifies the existing third one, by extracting one shared "connect-a-daemon" CTA fragment used in all three places.

## What Changes

- **New shared CTA component `DaemonConnectCta`.** A single presentational fragment (lives under `src/components/agent-presence/`) that renders: a short headline + body explaining that a long-lived `chorus daemon` keeps the agent online, the **exact command shown in `npx` form** with a one-click **copy** button, and a "Learn more" link to the onboarding install guide. It is prop-driven (a `variant`/size prop for compact vs. prominent) and fetches nothing.

- **Command shown in `npx` form, sourced from one constant.** Per the idea owner: the CLI publishes to npm (package `@chorus-aidlc/chorus`, bin `chorus`), and the target user has installed nothing, so the most copy-paste-runnable command is the zero-install `npx` form. The keep-alive command is `npx @chorus-aidlc/chorus daemon`; first run is preceded by `npx @chorus-aidlc/chorus login` (writes `~/.chorus/daemon.json`; the daemon resolves credentials by flag > env > login-file > plugin fallback). The command string is a **single exported constant**, never hardcoded per call site, so a future package/bin change updates all three surfaces at once. i18n messages carry only the surrounding prose, not the command literal.

- **Pill 0-online popover empty state → CTA.** In `agent-presence-pill.tsx`, the `popoverEmpty` line is replaced by the `DaemonConnectCta` (compact variant). It shows **only while 0 connections are online** and is **not dismissible** — once a daemon connects, the popover naturally renders the live connection list instead, so the CTA disappears on its own. No `localStorage`, no dismiss state (deferred as unnecessary complexity).

- **Onboarding completion screen → prominent "Next step" block.** In `CompletionStep.tsx`, a prominent "Next step" block is added (above or alongside the existing action buttons) using the `DaemonConnectCta` (prominent variant), emphasizing "installing the plugin ≠ staying online — run `chorus daemon` so your agent auto-receives dispatched work."

- **Agent Connections modal empty state → same shared CTA.** The hand-written `agentConnections.empty.body` block in `connections-view.tsx` is replaced by the shared `DaemonConnectCta`, so all three surfaces stay consistent and cannot drift. The existing `empty` i18n keys are reconciled into the shared CTA's keys.

- **i18n.** New keys for the CTA prose (headline, body, completion-screen "next step" framing, copy button label + copied state, "Learn more" link) added to **both** `messages/en.json` and `messages/zh.json`. The redundant `agentConnections.empty.body` command sentence is folded into the shared keys.

- **design.pen.** Update the pill popover empty-state, the onboarding completion screen, and the Agent Connections empty-state mocks to show the CTA.

## Capabilities

### New Capabilities

- `daemon-connect-cta`: The shared empty-state call-to-action that guides a user with no online daemon connection to run `chorus daemon` (npx form) — the single command constant, the three surfaces it appears on (pill popover empty state, onboarding completion screen, Agent Connections modal empty state), the copy + "Learn more" affordances, the non-dismissible "show only while 0 online" behavior, and the i18n + design.pen scope.

## Impact

- **Frontend only.** No daemon protocol change, no observability/session/transcript backend change (those belong to the parent and sibling ideas). No "detect whether the CLI is installed / daemon is running" probing — the CTA renders purely from the already-known "no online connection" state.
- **Affected files:** new `src/components/agent-presence/daemon-connect-cta.tsx` (+ barrel export); edits to `agent-presence-pill.tsx`, `connections-view.tsx`, `CompletionStep.tsx`; `messages/en.json` + `messages/zh.json`; `docs/design.pen`.
- **No DB / schema / migration impact. No new dependencies** (reuse existing shadcn/ui + lucide; copy-to-clipboard via the browser Clipboard API as elsewhere).

## Out of Scope

- Changing the daemon protocol, connection/session/transcript backend, or the SSE/presence provider data flow.
- Detecting local CLI/daemon presence; the CTA is static guidance gated only on "0 online connections."
- A dismissible / `localStorage`-remembered variant of the pill CTA.
- Touching the generic install-guide wizard steps (`InstallGuideStep`, `TestConnectionStep`) beyond linking to them.
