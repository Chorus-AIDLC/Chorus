# Tasks: Settings agent install guide

## 1. Extract shared install guide component

- [ ] 1.1 Create `src/components/install-guide/` and move `CodeBlock.tsx` there; update all importers.
- [ ] 1.2 Extract the five-tab guide body from `InstallGuideStep` into `AgentInstallGuide.tsx` (props `{ apiKey: string | null }`), verbatim, reading `onboarding.install.*` internally.
- [ ] 1.3 Refactor onboarding `InstallGuideStep` to render `<AgentInstallGuide apiKey={apiKey} />` inside its existing chrome (heading, motion, Back/Next).
- [ ] 1.4 Verify onboarding install step is behavior-preserving in the running app.

## 2. Surface guide in Settings + width

- [ ] 2.1 Extend `AgentCreateForm` success state to render `<AgentInstallGuide apiKey={createdKey} />` below the key block, above Done.
- [ ] 2.2 Adjust the Settings Create-API-Key modal width so the five-tab guide is comfortable in the success state.
- [ ] 2.3 Update `docs/design.pen` for the Settings success-state screen.
- [ ] 2.4 Verify in the running app: create a key in Settings, guide renders with the real key, all tabs + Copy work, Done clears it; `tsc`/`lint` clean.
