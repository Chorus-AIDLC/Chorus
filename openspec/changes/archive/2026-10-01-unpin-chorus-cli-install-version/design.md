# Design: Unpin the Chorus CLI install command

## Context

The string `@chorus-aidlc/chorus@0.17.0` is literally duplicated across ~20 user-facing files. There is
no shared constant, so each copy must be edited.

## Decisions

- **Unpinned, not re-pinned.** Use `npm install -g @chorus-aidlc/chorus` (npm resolves the `latest`
  dist-tag). Re-pinning to 0.20.x would rot again on the next release; the release process already
  keeps README pins current, and those stay out of scope.
- **Floor check unchanged.** The plugin MCP wrappers' `chorus >= 0.17.0` guard stays: `chorus mcp`
  does not exist below 0.17.0, so the guard protects old installs. Its upgrade hint already prints the
  unpinned command.
- **Tip wording.** Replace "(pinned to version 0.17.0)" with "installs the latest Chorus CLI globally"
  in all four locales, keeping each locale's existing phrasing style.

## Verification

- `grep -rn 'chorus-aidlc/chorus@0\.17' src messages public docs cli` returns nothing.
- `pnpm test` (incl. `agent-install-guide.test.tsx`), `pnpm lint`, `npx tsc --noEmit`, and
  `bash public/test-install-codex.sh` pass.

## Risks

- A future breaking CLI major could make unpinned installs incompatible with an older server. This is
  accepted: the server and CLI ship in lockstep, and the user asked for the default version.
