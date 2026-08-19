## Why

The dsh client type and installer are now available, but users cannot discover or configure dsh through the shared setup guide and the repository's connection documentation still omits it. dsh needs the same first-class onboarding and reference coverage as the existing supported harnesses.

## What Changes

- Add a localized `DeepSeek Harness` tab to the shared install guide between Kiro and OpenCode, while retaining `dsh` as its internal value.
- Present the same three-step flow used by Codex and Kiro: export the Chorus URL and API key, run `install-dsh.sh`, then launch dsh and verify a Chorus check-in.
- Keep the seven-tab selector readable on narrow screens with single-row horizontal scrolling.
- Add complete English and Chinese dsh connection guides aligned with the Codex and Kiro guide structure.
- Update daemon, MCP tool, and English/Chinese/Japanese/Korean README harness listings to include dsh.
- Update the onboarding design source in `docs/design.pen` through the Pencil MCP.
- Verify the UI in light and dark themes and preserve locale key parity across English, Chinese, Japanese, and Korean.

## Capabilities

### New Capabilities

- `dsh-connection-guide`: Defines the dsh connection documentation and supported-harness listing coverage.

### Modified Capabilities

- `agent-install-guide`: Expands the shared install guide to include a responsive, localized dsh setup flow.

## Impact

- Frontend: `src/components/install-guide/AgentInstallGuide.tsx` and focused component coverage.
- Localization: `messages/en.json`, `messages/zh.json`, `messages/ja.json`, and `messages/ko.json`.
- Documentation: new `docs/CONNECT_DSH.md` and `docs/CONNECT_DSH.zh.md`, plus harness-list updates in `docs/DAEMON.md`, `docs/MCP_TOOLS.md`, and all four README locales.
- Design source: `docs/design.pen`, modified only through Pencil MCP tooling.
- Dependencies: relies on the delivered dsh client type/presence label and `public/install-dsh.sh`; no new runtime dependency or API is introduced.
