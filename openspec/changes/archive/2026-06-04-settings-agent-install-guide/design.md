# Technical Design: Settings agent install guide

## Overview

Extract the tabbed install guide currently embedded in the onboarding `InstallGuideStep` into a single chrome-free presentational component, then render that component in two places: the onboarding wizard (unchanged behavior) and the Settings `AgentCreateForm` success state (new). The guide is keyed only by an `apiKey` string, so the same component serves both the live-key (creation-time) and placeholder cases without branching.

This is a pure frontend refactor + composition. No backend, schema, MCP, or i18n-content changes.

## Architecture

### Current state

```
onboarding/components/InstallGuideStep.tsx
  ├─ wizard chrome: <motion.div>, heading, <Card>, Back/Next <Button>s
  └─ tab body: <Tabs> with 5 <TabsContent> (claude-code, codex, opencode, openclaw, other)
       └─ depends on onboarding/components/CodeBlock.tsx
       └─ useTranslations("onboarding")  → keys under onboarding.install.*

components/AgentCreateForm.tsx
  └─ success state (createdKey && !embedded): check + warning + key <code> + Copy + Done
       └─ NO install guidance
```

### Target state

```
components/install-guide/AgentInstallGuide.tsx   ← NEW shared component (chrome-free)
  ├─ props: { apiKey: string | null }
  ├─ displayKey = apiKey || "<YOUR_API_KEY>"
  ├─ origin = window.location.origin (client-only; component is "use client")
  ├─ <Card><CardContent><Tabs …>  ← the exact 5-tab body moved out of InstallGuideStep
  └─ useTranslations("onboarding")  → still reads onboarding.install.* (namespace-self-contained)

components/install-guide/CodeBlock.tsx           ← MOVED from onboarding/components/CodeBlock.tsx

onboarding/components/InstallGuideStep.tsx       ← refactored
  ├─ keeps wizard chrome (motion, heading, Back/Next)
  └─ renders <AgentInstallGuide apiKey={apiKey} /> in place of inline tabs

components/AgentCreateForm.tsx                    ← success state extended
  └─ check + warning + key <code> + Copy
     + <AgentInstallGuide apiKey={createdKey} />   ← NEW, below the key
     + Done
```

## Component Contract: `AgentInstallGuide`

- **Location**: `src/components/install-guide/AgentInstallGuide.tsx` (shared, outside `onboarding/`).
- **Directive**: `"use client"` — it reads `window.location.origin` and uses `useTranslations`.
- **Props**: `{ apiKey: string | null }`. Nothing else. No `onNext`/`onBack`/heading — that chrome belongs to the host.
- **Key handling**: `const displayKey = apiKey || "<YOUR_API_KEY>"` (identical to today's `InstallGuideStep`). Callers that have the live key pass it; callers without it pass `null` and get the placeholder.
- **Rendered output**: the `<Card>` → `<CardContent>` → `<Tabs defaultValue="claude-code">` block with all five `<TabsContent>` panels, moved **verbatim** from `InstallGuideStep` (lines ~45–299). Same tab order, same `CodeBlock` snippets, same `onboarding.install.*` keys, same OpenCode/OpenClaw troubleshooting collapsibles.
- **Translations**: calls `useTranslations("onboarding")` internally. This keeps the guide self-contained — any host renders it without supplying a namespace and without the `onboarding.install.*` keys leaking into the host's own namespace. (Acceptable coupling: the guide content is conceptually "onboarding install" copy regardless of where it's shown. Moving the keys to a neutral namespace is out of scope and would churn both locale files for no user-visible gain.)
- **No host-specific styling assumptions**: width is controlled by the host container. The guide's outer element is the `<Card className="w-full">`, so it fills whatever the host gives it.

### `CodeBlock` move

`CodeBlock` is a leaf presentational component with no onboarding-specific logic. Move the file to `src/components/install-guide/CodeBlock.tsx`, update the import in `AgentInstallGuide` and in `InstallGuideStep` (if the latter still references it directly — after extraction it likely won't). Grep for any other importers before deleting the old path.

## Integration: onboarding `InstallGuideStep`

The refactor must be behavior-preserving. After the change, `InstallGuideStep` is:

- the same `<motion.div … className="flex w-full max-w-2xl flex-col items-center gap-6">` wrapper,
- the same centered heading (`t("steps.installGuide")` + `t("install.description")`),
- `<AgentInstallGuide apiKey={apiKey} />` where the inline `<Card>`/`<Tabs>` used to be,
- the same Back/Next button row.

Onboarding's visual result and the `apiKey` it already passes are unchanged. This is the regression-risk surface: the onboarding install step must look and behave pixel-for-pixel as before.

## Integration: Settings `AgentCreateForm` success state

The success branch is `if (createdKey && !embedded)` (current lines ~135–162). Extend it:

1. Keep the existing block: the `Check` + `settings.apiKeyCreated` header, the `settings.apiKeyCreatedDesc` warning, the key `<code>` + Copy button.
2. Insert `<AgentInstallGuide apiKey={createdKey} />` below the key block.
3. Keep the `Done` button (`handleClose`) at the very bottom.

The live `createdKey` flows into the guide, so the env-var exports and JSON/TOML snippets render with the real key while the dialog is open. On `handleClose` → `resetForm()` sets `createdKey = null`, the success branch unmounts, and the guide disappears along with the key. No persistence, no re-access — satisfies the "creation-time only" decision.

`embedded` mode is untouched: embedded callers (the onboarding wizard's own use of `AgentCreateForm`) never enter this success branch (`!embedded`), and onboarding shows the guide through its own `InstallGuideStep`. No double-render.

## Dialog width

The Settings Create API Key modal container is `max-w-[520px]` (`settings/page.tsx` ~line 508); onboarding's guide is sized at `max-w-2xl` (672px). Five tab triggers plus code blocks are cramped at 520px. Options, in order of preference:

1. **Widen the modal in the success state only** — e.g. switch the container to a wider max-width once `createdKey` is set, or always use a wider modal for this dialog. The modal already has `max-h-[90vh] overflow-y-auto`, so vertical overflow is already handled; only horizontal width needs attention.
2. Let the tabs wrap / rely on `overflow-x` — acceptable fallback but worse UX.

The implementing task should verify the five-tab layout is usable at the chosen width and that the form (pre-success) still looks right if the width is shared. Confirm against the real app (the verify step renders the dialog and inspects it).

## Module Contracts

- **`AgentInstallGuide` is presentational and stateless** beyond reading `window.location.origin`. It does not fetch, does not mutate, does not own the key. Hosts own the key lifecycle.
- **Translation namespace**: the guide owns `onboarding.install.*`. Hosts must not pass translation functions in; the guide resolves its own.
- **No new exports from `AgentCreateForm`**; only its internal JSX changes.

## Implementation Plan

1. Create `src/components/install-guide/` and move `CodeBlock.tsx` there; update importers.
2. Extract the tab body from `InstallGuideStep` into `AgentInstallGuide.tsx` (props `{ apiKey }`), verbatim.
3. Refactor `InstallGuideStep` to render `<AgentInstallGuide apiKey={apiKey} />` inside its existing chrome.
4. Extend `AgentCreateForm` success state to render `<AgentInstallGuide apiKey={createdKey} />` below the key.
5. Adjust the Settings modal width so the five-tab guide is comfortable.
6. Update `docs/design.pen` for the new Settings success-state screen.
7. Verify in the running app: onboarding install step unchanged; Settings create-key dialog shows the guide with the live key embedded; closing the dialog clears it.

## Risks & Mitigations

- **Onboarding regression** — the extraction is mechanical but onboarding is a critical first-run path. Mitigation: move the JSX verbatim, keep `apiKey` plumbing identical, and visually verify the onboarding step against the running app, not just types.
- **Width / layout cramping in the 520px modal** — five tabs + code blocks. Mitigation: widen the success-state dialog and verify the rendered layout (see Dialog width).
- **Translation namespace coupling** — `AgentInstallGuide` reads `onboarding.*` even when shown in Settings. Accepted as a deliberate trade-off (single source of truth > namespace purity); documented above. No key churn.
- **Stale `CodeBlock` import path** — grep all importers before deleting the old file to avoid a broken build.

## Verification

- `npx tsc --noEmit` and `pnpm lint` clean.
- Run the app: open `/settings`, create a key, confirm the install guide renders below the key with the **real** key in the snippets, all five tabs work, Copy works, Done clears it.
- Open `/onboarding`, reach the install step, confirm it is visually and behaviorally identical to before.
