## Why

Chorus can wake dsh only after dsh has an English, harness-aware copy of the AI-DLC workflow and the prompt configuration needed to apply it. The existing standalone skills are the semantic baseline, but they do not encode dsh's skill catalog, headless interaction, or reviewer-delegation behavior.

## What Changes

- Add an installer-ready `public/dsh-plugin/` bundle containing explicit dsh-adapted copies of the complete Chorus skill set.
- Add an opt-in Chorus agent preset that mounts a Chorus PM/developer persona and `@deepseek-ai/dsh-agent-instructions` without changing dsh's stock presets.
- Add Chorus workspace rules under a preset-specific instruction root so stock dsh sessions do not inherit Chorus behavior.
- Define the file-placement contract consumed by the sibling `install-dsh.sh` work.
- Add static validation and a local dsh discovery/prompt smoke test covering the skill catalog, skill loading, persona, and AGENTS instructions.
- Exclude installation logic, MCP connection wiring, event hooks, live Chorus calls, and full real-machine workflow verification.

## Capabilities

### New Capabilities

- `dsh-skill-bundle`: Installer-ready dsh skills and prompt configuration that make the Chorus workflow discoverable and active in an opt-in Chorus preset.

### Modified Capabilities

None.

## Impact

- Adds a new distribution surface under `public/dsh-plugin/`.
- Uses dsh's existing filesystem skill provider, `skill` tool, agent preset roster, persona row, and agent-instructions row; it adds no runtime dependency to Chorus.
- Establishes an input contract for sibling idea `7ee741cf-67ce-4fb0-9de4-796a8a2b3040`, which owns installation into `$DSH_HOME`.
- Targets the locally verified dsh `0.1.0-rc.7` configuration and skill contracts.
