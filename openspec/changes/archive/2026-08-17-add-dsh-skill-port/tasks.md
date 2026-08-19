## 1. Build the installer-ready dsh bundle

- [x] 1.1 Add the `public/dsh-plugin/` layout, README handoff contract, all fourteen English dsh-adapted `SKILL.md` files, the `standard`-derived Chorus preset, and the preset-specific Chorus `AGENTS.md`.
- [x] 1.2 Adapt invocation, MCP namespace, headless decision routing, reviewer delegation/fallback, and OpenSpec behavior while preserving the maintained Chorus workflow and verdict contracts.

## 2. Validate dsh integration

- [x] 2.1 Add focused static validation for bundle membership, frontmatter, English descriptions, forbidden host-only assumptions, and required preset persona/instruction configuration.
- [x] 2.2 Install the bundle into an isolated temporary dsh home and run a local dsh `0.1.0-rc.7` smoke test proving catalog discovery, skill loading, persona assembly, and Chorus AGENTS injection without a live Chorus workflow call.
