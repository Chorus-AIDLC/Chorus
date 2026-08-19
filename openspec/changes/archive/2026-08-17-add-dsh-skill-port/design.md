## Context

dsh `0.1.0-rc.7` already provides every runtime primitive this MVP needs:

- `@deepseek-ai/dsh-skill-filesystem` scans `$DSH_HOME/skills` and exposes valid `SKILL.md` files through the `<available_skills>` catalog.
- `@deepseek-ai/dsh-tool-skill` supplies the model-facing `skill` loader.
- user-authored presets are discovered under `$DSH_HOME/.agent-presets/<id>/`.
- `@deepseek-ai/dsh-persona` shadows the deployment persona inside a preset.
- `@deepseek-ai/dsh-agent-instructions` loads a user-global `AGENTS.md` from its configured `dshHome`.

The standalone `public/skill/` tree is the semantic baseline, but direct reuse was rejected during elaboration because dsh has distinct skill invocation, headless interaction, namespaced MCP, and reviewer-delegation mechanics. Installation belongs to the sibling dsh installer idea, and TypeScript event hooks belong to a later plugin idea.

## Goals / Non-Goals

**Goals:**

- ship one self-contained, English, installer-ready bundle under `public/dsh-plugin/`;
- preserve the Chorus AI-DLC semantics while adapting harness-specific instructions for dsh;
- keep Chorus persona and instructions opt-in through a dedicated preset;
- give the installer a deterministic source-to-destination mapping;
- prove the bundle with static checks and a real local dsh prompt/discovery smoke test.

**Non-Goals:**

- writing or changing `install-dsh.sh`;
- configuring the Chorus MCP server or credentials;
- implementing check-in, turn reporting, reviewer hooks, or any other event-driven plugin behavior;
- calling a live Chorus server from the smoke test;
- replacing all Chorus skill surfaces with generated sources.

## Decisions

### 1. Ship a dedicated `public/dsh-plugin/` distribution surface

The bundle uses this logical layout:

```text
public/dsh-plugin/
├── README.md
├── skills/
│   ├── chorus/SKILL.md
│   ├── idea-chorus/SKILL.md
│   ├── proposal-chorus/SKILL.md
│   ├── develop-chorus/SKILL.md
│   ├── yolo-chorus/SKILL.md
│   ├── review-chorus/SKILL.md
│   ├── quick-dev-chorus/SKILL.md
│   ├── brainstorm-chorus/SKILL.md
│   ├── openspec-aware-chorus/SKILL.md
│   ├── orchestrate-chorus/SKILL.md
│   ├── docs-chorus/SKILL.md
│   ├── proposal-reviewer-chorus/SKILL.md
│   ├── task-reviewer-chorus/SKILL.md
│   └── code-reviewer-chorus/SKILL.md
├── agent-presets/
│   └── chorus/
│       ├── agent.cordis.yml
│       └── preset.yml
└── instructions/
    └── AGENTS.md
```

The sibling installer copies `skills/*` into `$DSH_HOME/skills/`, the preset directory into `$DSH_HOME/.agent-presets/chorus/`, and the instruction file into `$DSH_HOME/chorus/AGENTS.md`. This idea does not perform those writes.

Alternative considered: put files directly into a developer's `$DSH_HOME`. Rejected because user-home mutations are installer behavior and are not reviewable release artifacts.

### 2. Maintain explicit dsh-adapted skill copies

Each skill is an English `SKILL.md` with valid dsh frontmatter. The files retain the standalone surface's collision-resistant `-chorus` stage names while using `chorus` for the overview/router.

Adaptations cover:

- use of the dsh `skill` tool and `<available_skills>` catalog;
- Chorus MCP names as exposed by dsh's MCP namespace, without assuming bare Claude Code tool identifiers;
- headless sessions never invoking interactive question tools; human decisions go to Chorus elaboration/comments and the turn ends;
- reviewer execution through an available dsh sub-agent path, with an inline read-only fallback when delegation is unavailable;
- OpenSpec detection performed in the skill because dsh has no Chorus SessionStart hook;
- no assumption that PostToolUse or lifecycle hooks inject follow-up instructions.

The skill bodies remain semantically aligned with `public/skill/` and the maintained Chorus reviewer skills. This is deliberately manual for the MVP; generation is a possible follow-up.

Alternative considered: install `public/skill/` unchanged. Rejected because host-specific interaction and reviewer instructions would be incorrect in a headless dsh turn.

### 3. Use a dedicated, `standard`-derived Chorus preset

`agent.cordis.yml` is a complete dsh preset based on the verified `standard` preset so direct MCP and `skill` tools remain available. It changes the identity rows as follows:

- `@deepseek-ai/dsh-persona` contains a concise Chorus PM/developer persona;
- `@deepseek-ai/dsh-agent-instructions` keeps the normal project instruction discovery but sets `dshHome` to the resolved `$DSH_HOME/chorus` instruction root and retains a bounded prompt budget.

The path expression must support both explicit `DSH_HOME` and dsh's default `~/.dsh`. `preset.yml` presents the preset as Chorus-specific. Existing `standard` and `code` presets remain untouched.

Alternative considered: patch dsh's stock presets. Rejected because it would make every dsh session Chorus-aware. A global `$DSH_HOME/AGENTS.md` was also rejected because it would bypass preset opt-in.

### 4. Treat the bundle README as the installer interface

The README records the exact copy mapping, required dsh version/rows, expected skill names, overwrite/idempotency expectations delegated to the installer, and the fact that MCP wiring must be installed separately. This keeps the two sibling changes independently reviewable while making their integration contract explicit.

### 5. Verify behavior without depending on live MCP wiring

Static validation checks the expected file set, kebab-case/matching frontmatter names, non-empty English descriptions, absence of known Claude/Codex-only interaction instructions, preset YAML loadability in dsh's dialect, and required persona/instruction rows.

The runtime smoke test uses a temporary dsh home populated from the bundle, boots a local dsh session with the Chorus preset, and captures model-visible evidence that:

1. the expected Chorus entries appear in `<available_skills>`;
2. the `skill` tool can load at least the overview and one stage skill;
3. the assembled system prompt contains the Chorus persona;
4. the initial instruction context contains the Chorus AGENTS rules.

It does not require a successful `chorus_*` call. That belongs to the MCP installer and full dsh E2E ideas.

## Risks / Trade-offs

- **Skill copies can drift from other Chorus surfaces.** Mitigation: identify `public/skill/` and maintained reviewer skills as the semantic baseline, add parity-oriented static assertions, and leave generation as an explicit follow-up.
- **A complete preset can drift from dsh's upstream `standard` preset.** Mitigation: document the verified dsh version, keep changes limited to identity/instruction configuration, and make preset boot part of the smoke test.
- **Global skill discovery exposes Chorus skill names to stock presets.** Mitigation: the active persona and Chorus operating rules remain preset-scoped; merely listing optional skills does not make a stock session a Chorus worker.
- **OpenSpec document mirroring needs a wrapper supplied by installation work.** Mitigation: the dsh skill requires the sibling installer to provide executable `$DSH_HOME/chorus/bin/chorus-mcp-call.sh` with the two-argument `<tool-name> <json-arguments>` contract and halts visibly when it is absent; this bundle does not silently downgrade byte-exact mirroring.
- **Local smoke tests can be environment-sensitive.** Mitigation: isolate `DSH_HOME`, avoid live Chorus calls, record the exact dsh checkout/version, and retain static validation as a deterministic baseline.

## Migration Plan

1. Land the bundle without changing any existing installation.
2. Have the sibling installer copy the documented artifacts into the three `$DSH_HOME` destinations.
3. Select the `chorus` preset for Chorus-driven sessions.
4. Roll back by removing the installed `chorus` preset, Chorus instruction root, and copied Chorus skill directories; stock dsh presets are unchanged.

## Open Questions

None. Runtime MCP wiring and full daemon workflow acceptance are intentionally delegated to their sibling ideas.
