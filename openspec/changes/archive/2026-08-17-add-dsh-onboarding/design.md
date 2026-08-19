## Context

The shared `AgentInstallGuide` currently renders one tab per supported client and is reused by onboarding and the Settings API-key success state. The dsh client type and `public/install-dsh.sh` already exist, so this change is presentation and documentation work. Adding dsh raises the selector to seven tabs, which makes the current equal-width row fragile at narrow widths.

The repository also treats `docs/design.pen` as an encrypted design source. It must be inspected and edited through Pencil MCP tools rather than filesystem commands.

## Goals / Non-Goals

**Goals:**

- Make dsh discoverable as a first-class harness in every shared install-guide host.
- Keep the setup sequence and terminology consistent with the delivered dsh installer and client label.
- Preserve readable tab labels on constrained viewports.
- Keep four locale files structurally identical and provide natural localized copy.
- Bring dsh connection and harness-list documentation to parity with Codex and Kiro.
- Keep the checked-in Pencil design aligned with the implemented onboarding state.

**Non-Goals:**

- Changing the dsh installer, daemon backend, presence protocol, or session-list behavior.
- Adding a live connection test to the Settings key-creation flow.
- Translating the full dsh connection guide beyond English and Chinese.
- Redesigning the overall onboarding or Settings dialog.

## Decisions

### Use the display label `DeepSeek Harness` and established harness order

The new trigger is labeled `DeepSeek Harness` and appears between Kiro and OpenCode. Its internal tab value and translation namespace remain `dsh`. This matches the presence label already delivered while treating dsh as a supported harness rather than an "Other" client.

Alternative considered: label the tab `dsh`. Rejected because it would expose the raw client type and diverge from the `DeepSeek Harness` label users see in presence and session surfaces.

### Mirror the Codex and Kiro three-step setup flow

The dsh tab contains:

1. Exports for `CHORUS_URL` and `CHORUS_API_KEY`, using the current origin and live-or-placeholder key behavior.
2. `curl -fsSL ${origin}/install-dsh.sh | bash`.
3. A localized instruction to launch dsh and verify by asking it to check in to Chorus.

This keeps onboarding useful end to end while leaving detailed installer behavior and troubleshooting in the connection guides.

Alternative considered: show only the installer command. Rejected because the established supported-harness tabs include environment setup and verification.

### Make the tab list a single horizontally scrollable row

The tab list remains one row with non-shrinking triggers and horizontal overflow available when the container cannot fit all labels. Wide layouts continue to show the complete row without unnecessary wrapping; narrow layouts can use touch, trackpad, or pointer scrolling.

Alternative considered: wrap the selector into multiple rows. Rejected because wrapping changes the control's height and scan order and is unnecessary for this contained addition.

### Extend localization through the existing namespace

Each locale receives the same `onboarding.install.tabs.dsh` and `onboarding.install.dsh.*` key structure. The implementation uses semantic foreground/background/border tokens already present in the component; any explicit status color must include a suitable `dark:` variant.

Locale parity tests remain the structural guard. Focused component tests cover tab visibility, ordering, command interpolation, placeholder/live-key behavior, and narrow-width classes or behavior.

### Treat documentation and Pencil design as part of the feature contract

`CONNECT_DSH.md` and `CONNECT_DSH.zh.md` mirror the existing Codex/Kiro organization: prerequisites, environment variables, installer behavior, verification, non-interactive use, troubleshooting, and next links. README and reference-document harness lists are updated without unrelated editorial changes.

The implementation uses Pencil MCP to locate the existing onboarding tab design, add the dsh state, and validate the result. The `.pen` file is never read or written through shell/file tools.

## Risks / Trade-offs

- [Seven tabs can still exceed very small widths] -> Use non-shrinking triggers plus horizontal overflow and verify representative mobile and desktop viewports.
- [Localized strings can drift structurally] -> Add identical key paths in all four locale files and run locale parity tests.
- [Docs can claim behavior the installer does not provide] -> Derive installer details from `public/install-dsh.sh` and keep command examples executable.
- [Concurrent dependency work is already present in the worktree] -> Scope edits narrowly and preserve all existing dsh client/installer changes.
- [Pencil source can diverge from the code] -> Update it in the same task and validate the resulting design through Pencil MCP.

## Migration Plan

No data or API migration is required. Ship the shared guide, translations, docs, and design-source update together. Rollback consists of reverting those presentation/documentation changes; the dsh client type and installer remain independently usable.

## Open Questions

None. The elaboration fixed the label/order, responsive behavior, onboarding depth, and guide depth.
