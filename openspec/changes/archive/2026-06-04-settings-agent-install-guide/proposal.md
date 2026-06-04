# Proposal: Settings agent install guide

## Why

The onboarding wizard already teaches a new user how to connect an agent. After they create their first agent and copy the `cho_` key, **Step 3 (`InstallGuideStep`)** shows a full tabbed install guide covering five client types — Claude Code, Codex, OpenCode, OpenClaw, and Other Agents — with env-var exports, shell installers, MCP JSON config, and troubleshooting. The user finishes onboarding knowing exactly how to wire up their agent.

But onboarding runs **once**. Every subsequent agent is created from **Settings → Create API Key**, and that flow is a dead end. `AgentCreateForm`'s success state shows only:

- a green "API Key Created" check,
- the raw `cho_` key in a code block,
- a Copy button,
- a Done button.

There is **no setup guidance at all** — no MCP config snippet, no env-var exports, no client picker, no link back to onboarding or `SKILL.md`. The moment the user clicks Done, the key (shown only once) is gone and they are dropped back to the agent list with nothing telling them what to do next. A user who creates their second, third, or tenth agent has to remember the onboarding steps from memory or hunt through docs.

This is the single concrete gap the user asked us to close: **make creating an agent in Settings feel like the onboarding experience — give them the install methods right where they got the key.**

## What Changes

- **Extract the onboarding install guide into a shared, chrome-free component.** The tabbed guide body inside `InstallGuideStep` (the `<Card>` + `<Tabs>` with all five client tabs) becomes a standalone presentational component — call it `AgentInstallGuide` — that takes an `apiKey` prop and renders only the tabs. It carries **no** wizard chrome: no page heading, no framer-motion wrapper, no Back/Next buttons. Single source of truth; both call sites render the exact same guide content.
- **`InstallGuideStep` (onboarding) is refactored to consume `AgentInstallGuide`.** It keeps its wizard chrome (heading, motion, Back/Next) and renders `<AgentInstallGuide apiKey={apiKey} />` in place of its inline tabs. Onboarding behavior is unchanged, pixel-for-pixel.
- **`AgentCreateForm` success state renders the guide inline, below the key.** After a key is created in Settings, the success state keeps everything it shows today (the "API Key Created" check, the warning text, the key code block, Copy) and adds `<AgentInstallGuide apiKey={createdKey} />` directly **below** it, then the Done button at the bottom. One dialog: key first, then install tabs, then Done.
- **All five client tabs, full parity with onboarding.** Claude Code, Codex, OpenCode, OpenClaw, Other Agents — the same tabs, same copy, same `onboarding.install.*` translation keys. No curated subset.
- **The real key is embedded, creation-time only.** The guide receives the live `cho_` key while the success state is showing, so the env-var exports and config snippets contain the actual key (not a placeholder). When the dialog closes the guide is gone, exactly like the key itself. No later re-access from the agent list, no key-rotation affordance.
- **No "Test connection" step.** The Settings flow stays lightweight — it shows the install guide and stops. It does not wait for `chorus_checkin` or add a connection-test step the way onboarding does.
- **`CodeBlock` moves to a shared location** alongside `AgentInstallGuide` (it currently lives under `src/app/onboarding/components/`), since both onboarding and Settings now depend on it. The onboarding import is updated to the new path.

## Capabilities

### New Capabilities

- `agent-install-guide`: The reusable agent install/config guide — what it renders (five client tabs keyed by `apiKey`), the fact that it carries no host-specific chrome, and the requirement that both the onboarding wizard step and the Settings key-creation success state render it from a single shared component so the two never drift.

## Impact

- **Frontend code**:
  - New shared component `AgentInstallGuide` (the chrome-free tabbed guide), extracted verbatim from the current `InstallGuideStep` tab body. Lives in a shared path (e.g. `src/components/install-guide/`), not under `onboarding/`.
  - `CodeBlock` relocated from `src/app/onboarding/components/CodeBlock.tsx` to the shared path; its sole behavior is unchanged.
  - `src/app/onboarding/components/InstallGuideStep.tsx` — refactored to wrap `<AgentInstallGuide>` with its existing wizard chrome; import path for `CodeBlock` updated.
  - `src/components/AgentCreateForm.tsx` — success-state branch (lines ~135–162) gains `<AgentInstallGuide apiKey={createdKey} />` below the key block, above Done.
  - `src/app/(dashboard)/settings/page.tsx` — the Create API Key modal container (`max-w-[520px]`, line ~508) may need to widen in the success state to comfortably fit the five-tab guide (onboarding uses `max-w-2xl`/672px). The dialog already has `max-h-[90vh] overflow-y-auto`, so vertical growth is handled.
- **i18n**: **no new keys for the guide body** — it reuses the existing `onboarding.install.*` keys, and `AgentInstallGuide` calls `useTranslations("onboarding")` internally so it stays namespace-self-contained regardless of caller. If a short Settings-context intro line above the guide is desired, that is the only candidate new key (added to both `en.json` and `zh.json`).
- **No backend / schema / MCP / permission changes.** This is a pure frontend UX change. No new dependencies, no migrations, no API routes.
- **Backward compat**: fully additive. Onboarding renders identically; the only behavioral change is that the Settings success state now shows the guide where it previously showed nothing.

## Out of Scope

- Re-accessing the guide later from the agent list (the key isn't stored; explicitly creation-time only).
- Regenerating / rotating an agent's key to re-embed a live key into the guide.
- A "Test connection" / `chorus_checkin` confirmation step in Settings.
- Curating or reordering the client tabs, or adding new client types.
- Any change to onboarding's flow, steps, or visuals beyond the mechanical extraction of the shared component.
