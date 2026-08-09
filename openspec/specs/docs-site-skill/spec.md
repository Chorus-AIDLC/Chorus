# docs-site-skill Specification

## Purpose
Define the agent-facing "docs" skill that routes agents to the live Chorus documentation site (index via `/llms.txt`, raw Markdown via appended `.md`) so both humans and agents can find and ground product-usage guidance in current docs, present on all six skill surfaces and cross-referenced from the overview.
## Requirements
### Requirement: Docs-site routing skill on every surface

Chorus SHALL provide an agent-facing "docs" skill that routes agents to the live Chorus documentation site to answer product-usage questions. The skill SHALL exist on all six skill surfaces (Claude Code, Codex, OpenClaw, Kiro, Pi, standalone), following each surface's naming convention (`docs`; Kiro `chorus-docs`; standalone `docs-chorus`).

The skill SHALL teach the docs-site access convention: read `https://doc.chorus-ai.dev/llms.txt` as the index first, then fetch any page's raw Markdown by appending `.md` to its URL, and ground product-usage answers in the fetched docs rather than memory. The skill SHALL NOT hardcode a page catalog. The skill SHALL use the live host `doc.chorus-ai.dev`.

#### Scenario: User asks how to use Chorus and the agent consults the docs

- **WHEN** a user asks an agent how to use, configure, deploy, or operate Chorus, and the docs skill is available
- **THEN** the skill directs the agent to fetch `/llms.txt`, select the relevant page(s) from the index, fetch their `.md` raw Markdown, and answer from that content while linking the human-facing page

#### Scenario: Skill is registered on each surface

- **WHEN** the plugin/skill package for any of the six surfaces is loaded
- **THEN** the docs skill is discoverable — folder-present for Claude Code / Codex / OpenClaw / Pi, listed in `public/skill/package.json` (both `chorus` and `moltbot` file maps + a `docs` trigger) for standalone, and listed in `install-kiro.sh` `SKILLS=` plus `agents/chorus.json` `resources[]` for Kiro

#### Scenario: Docs skill is cross-referenced from the overview

- **WHEN** an agent reads the `chorus` overview skill (or Kiro's `steering/chorus.md`)
- **THEN** a Skill-Routing entry names the docs skill so it is reachable from the platform overview on all six overview surfaces

