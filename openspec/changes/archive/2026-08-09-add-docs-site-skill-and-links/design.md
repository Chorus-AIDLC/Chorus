# Design: docs-site skill and product links

## Context

- Live docs site: `https://doc.chorus-ai.dev`. Agent-friendly access:
  - `https://doc.chorus-ai.dev/llms.txt` — link index (title + one-line summary + `.md` URL per page).
  - Any page + `.md` → raw Markdown (e.g. `/guides/getting-started.md`). The docs build emits both HTML and `.md` for every route.
- Locales on the docs site: `en` (unprefixed root), `zh`, `ja`, `ko` (path-prefixed).
- Skill content lives in **six parallel surfaces** (per `.claude/skills/plugin-maintenance/SKILL.md`):
  1. `public/chorus-plugin/skills/<name>/SKILL.md` — Claude Code
  2. `plugins/chorus/skills/<name>/SKILL.md` — Codex
  3. `packages/openclaw-plugin/skills/<name>/SKILL.md` — OpenClaw
  4. `public/kiro-plugin/.kiro/skills/chorus-<name>/SKILL.md` — Kiro (prefix)
  5. `packages/chorus-pi/skills/<name>/SKILL.md` — Pi
  6. `public/skill/<name>-chorus/SKILL.md` — standalone (suffix)

## Goals / Non-Goals

**Goals**
- One new agent-facing skill that routes agents to the docs site, on all six surfaces, correctly registered on each.
- The skill discoverable from the `chorus` overview (Skill Routing row) on all six overview surfaces.
- README (×4 locales) and landing nav link to the docs site.

**Non-Goals**
- No change to the `chorus-doc` repo.
- No hardcoded page catalog in the skill (avoids staleness — the site's own `/llms.txt` is the index).
- No new locales for README or landing beyond what already exists.
- Not fixing the docs-repo `docs.chorus-ai.dev` vs `doc.chorus-ai.dev` mismatch (upstream, out of scope; recorded in proposal Impact).

## Decisions

### D1 — Skill base name per surface
The user's shorthand is "chorus-doc". Per-surface naming convention (from plugin-maintenance) is applied so invocation is not redundant:

| Surface | Folder / file | Invocation |
|---|---|---|
| Claude Code | `skills/docs/SKILL.md` | `/chorus:docs` |
| Codex | `skills/docs/SKILL.md` | `$docs` |
| OpenClaw | `skills/docs/SKILL.md` | `/docs` |
| Kiro | `.kiro/skills/chorus-docs/SKILL.md` | `/chorus-docs` |
| Pi | `skills/docs/SKILL.md` | `/skill:docs` |
| standalone | `public/skill/docs-chorus/SKILL.md` | download by URL |

`name:` frontmatter matches the folder base (`docs`, except Kiro `chorus-docs` and standalone `docs-chorus`, mirroring how the existing skills name themselves on each surface).

### D2 — Skill is a thin router, not a page catalog
Body outline (adapt tone per surface — MUST/NEVER for plugin ports, "prefer/consider" for standalone):
- **When to use:** the user asks how to use / configure / deploy / operate Chorus (UI workflow, agent setup, plugin setup, API/MCP, deployment, troubleshooting) — anything covered by product documentation rather than the live AI-DLC workflow this agent is driving.
- **Access convention:**
  1. Fetch `https://doc.chorus-ai.dev/llms.txt` — the index of every page with a one-line summary and its `.md` URL.
  2. Pick the relevant page(s) from the index and fetch the raw Markdown by appending `.md` to the page URL.
  3. Ground the answer in the fetched docs; cite/link the human-facing page (HTML URL, i.e. the `.md` URL without the suffix) so the user can open it.
- **Locale note:** `en` is the root; `zh` / `ja` / `ko` are path-prefixed (`/zh/...`). Match the user's language when available; the `.md` convention applies to prefixed pages too.
- **Relationship:** complements the workflow skills (`idea` / `proposal` / `develop` / `review` / `yolo`), which drive the AI-DLC pipeline. `docs` answers "how do I use the product" questions.
- **No hardcoded page list** — the index is the source of truth; do not enumerate pages in the skill body.
- Fetch mechanism is left to the agent's available tooling (WebFetch / curl / built-in) — the skill states the convention, not a specific tool binding, so it works across harnesses.

### D3 — Registration per surface (the non-obvious part)
- **Folder-discovered (no manifest edit):** Claude Code, Codex (`"skills": "./skills/"`), OpenClaw (`"skills": ["./skills"]`), Pi (`"skills": ["./skills"]`). Dropping the folder is sufficient.
- **standalone** — must add `docs-chorus/SKILL.md` to the file map in **both** the `chorus` and `moltbot` blocks of `public/skill/package.json`, and add a `docs` trigger keyword to both `triggers` arrays.
- **Kiro** — must add `chorus-docs` to the `SKILLS=` list in `public/install-kiro.sh` **and** add `skill://.kiro/skills/chorus-docs/SKILL.md` to `resources[]` in `public/kiro-plugin/.kiro/agents/chorus.json`.

### D4 — Overview cross-reference
Add one Skill-Routing row (or equivalent list entry) naming the new skill on each overview surface:
- CC/Codex/OpenClaw/Pi/standalone: `skills/chorus/SKILL.md` (and `public/skill/chorus/SKILL.md`) "Skill Routing" table — a new row, e.g. **Docs** | `/docs` (adapt invocation token per surface) | "Consult the live Chorus documentation site to guide product usage".
- Kiro: `public/kiro-plugin/.kiro/steering/chorus.md` (its overview) — add the equivalent line.

### D5 — README docs link
Add a single prominent "Documentation" link immediately after the existing language-switch `<p align="center">` line, in each of README.md / README.zh.md / README.ko.md / README.ja.md. Label localized ("Documentation" / "文档" / "문서" / "ドキュメント"); URL `https://doc.chorus-ai.dev` for all four (site auto-serves per-locale; the READMEs already differ per language and a single canonical URL is simplest and correct). Keep the existing badges block untouched (owner chose a link, not a shields badge).

### D6 — Landing nav Documentation entry
- `packages/landing/src/i18n/translations/en.json` + `zh.json`: add `nav.docs` key ("Documentation" / "文档").
- `packages/landing/src/components/Nav.astro`:
  - Compute `const docsUrl = lang === 'zh' ? 'https://doc.chorus-ai.dev/zh' : 'https://doc.chorus-ai.dev';` (language-aware, D per elaboration Q5).
  - Desktop `.nav-links`: add `<a href={docsUrl} target="_blank" rel="noopener noreferrer">{t(lang, 'nav.docs')}</a>` adjacent to Blog (order: Features / Showcase / Agents / Docs / Blog).
  - Mobile `#mobile-menu`: add the same link in the same position.
  - New tab (`target="_blank"`) because the docs site is a separate deployment (elaboration Q6).

## Risks / Trade-offs

- **Docs-site link rot:** if a page slug changes, the skill still works (it reads `/llms.txt` fresh each time); only the README/landing root link is fixed, and the root is stable.
- **Six-surface drift:** the new skill must stay in sync across surfaces. Mitigated by authoring one canonical body and porting with the intentional per-surface phrasing differences (tone, invocation token, tool namespacing) called out in plugin-maintenance.
- **Upstream URL mismatch** (`docs.` vs `doc.`): we consistently use the live `doc.chorus-ai.dev`; documented as a known upstream issue so a later reader doesn't "fix" our correct links to match the dead default.

## Migration / Rollout

Pure additive. No schema, no data, no runtime behavior change. Version frontmatter bumped for touched skill surfaces per plugin-maintenance Version Bump Checklist (the release itself is a separate step, not part of this change).
