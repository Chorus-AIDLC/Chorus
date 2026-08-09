# Add docs-site skill and product links

## Why

The standalone Chorus documentation site is live at **https://doc.chorus-ai.dev** (en / zh / ja / ko), built by the docs-site theme idea. It is agent-friendly: the root `/llms.txt` is a link index, and appending `.md` to any page URL returns raw Markdown. But nothing inside the product points to it:

- **Agents** have no instruction to consult the docs site. When a user asks "how do I use / configure / deploy / operate Chorus", an agent answers from memory instead of the authoritative, current docs.
- **README** (en / zh / ko / ja) — the first thing a GitHub visitor reads — has no link to the docs.
- **Landing page** (`packages/landing`) nav has Features / Showcase / Agents / Blog, but no Documentation entry.

This change wires the live site into the three product entry points so both humans and agents can find and use it.

## What Changes

1. **New `docs` skill** across all six skill surfaces (Claude Code, Codex, OpenClaw, Kiro, Pi, standalone), matching where the existing stage skills (`idea`, `proposal`, …) live. The skill is a **thin router**: it teaches the agent the docs-site access convention — read `/llms.txt` first for the index, then fetch any page with `.md` appended for raw Markdown — and to ground user-facing "how to use Chorus" guidance in those docs rather than memory. It deliberately does **not** hardcode a page list (which would go stale as the docs site changes).
   - Registration is per-surface: folder-discovered on Claude Code / Codex / OpenClaw / Pi; explicitly listed for standalone (`public/skill/package.json` file maps + triggers) and Kiro (`install-kiro.sh` `SKILLS=` + `agents/chorus.json` `resources[]`).
   - Per-surface base name follows each surface's convention: `docs` (CC/Codex/OpenClaw/Pi), `chorus-docs` (Kiro prefix), `docs-chorus` (standalone suffix). The user's shorthand "chorus-doc" refers to the concept; `/chorus:chorus-doc` would be redundant.

2. **Cross-reference from the `chorus` overview skill** — add one Skill-Routing row pointing at the new `docs` skill, so it is discoverable from the platform overview (all six overview surfaces; Kiro's overview is `steering/chorus.md`).

3. **README docs link** — add a prominent "Documentation" link to the top of all four README locales (en / zh / ko / ja), near the language-switch line.

4. **Landing-page Documentation nav** — add a "Documentation" entry to the landing nav (`Nav.astro`), in both the desktop links and the mobile menu, with `en` / `zh` i18n copy. It opens in a new tab (external site) and is placed adjacent to Blog. Target is language-aware: the `en` landing links to the docs-site root; the `zh` landing links to `/zh`.

## Capabilities

- `docs-site-skill` — the new agent-facing skill and its cross-reference from the overview.
- `readme-docs-link` — the docs link in all four README locales.
- `landing-docs-nav` — the Documentation nav entry on the landing page.

## Impact

- **Skill surfaces:** one new `SKILL.md` per surface (six files), plus registration edits on standalone + Kiro, plus one routing row in each of the six overviews. Version frontmatter bumped per the plugin-maintenance checklist for the surfaces touched.
- **README:** four files, header only.
- **Landing:** `Nav.astro` + `en.json` / `zh.json` nav keys.
- **Out of scope / not modified:**
  - The `chorus-doc` repository itself is untouched (this change lives entirely in the `ai-pm` repo).
  - **Known upstream bug, recorded not fixed:** the docs-site repo's `DOCS_SITE_URL` default and its generated `llms.txt` internal links point to `docs.chorus-ai.dev` (with an "s"), which is currently a dead host; the live site is `doc.chorus-ai.dev`. All links added here use the live `doc.chorus-ai.dev`. Fixing the docs-repo mismatch is a separate concern in that repo.
