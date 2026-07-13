# Design: Strengthen reference-artifact association

## Context

This is a documentation + prompt + one-CSS-fix change. No schema, API, or runtime-logic change. The scope was fixed by a one-round elaboration (idea `623af7aa`), whose answers are the binding contract:

- **Q1 = a** — surfaces are skill docs + wake prompts only. NOT MCP tool descriptions, NOT an empty-references soft-hint UI feature.
- **Q2 = "a + chorus skill"** + a UI overflow bug fix — reference guidance goes into the idea skill and the chorus overview skill; plus fix the long-URL-not-truncated display bug.
- **Q3 = a** — one-line reflex nudge in both wake prompts (they are already long; keep it compact).
- **Q4 = a** — teach the four-type selection criteria + a full inline example.
- **Q5 = a** — include one generic example (docs are public + English, so the example is a generic locale/official-docs scenario, not bound to an internal idea).

## Goal

Make "attach external references" a default agent reflex: the moment an agent sees an external link (precedent issue/PR, reference implementation, official docs, paper/blog), it attaches it via references — preferring the inline `references[]` param **at creation time** over a post-hoc `chorus_add_reference`.

## Decisions

### D1 — Skill roots are NOT byte-identical; adapt per root

The four idea SKILLs differ by design (frontmatter `name:`, cross-link style `/chorus` vs `` `chorus` skill ``, host prompt mechanism, and the OpenClaw `chorus__` tool-namespace note). The same is true for the four chorus SKILLs. So this change inserts the **same guidance content**, adapted to each root's existing conventions — never a blind copy of one file over another. The parity to preserve is *semantic* (every root teaches the same reference reflex), not textual.

Root-specific adaptation rules:
- **standalone** (`public/skill/idea-chorus`, `public/skill/chorus`): cross-links use `` `chorus` skill (`<BASE_URL>/skill/chorus/SKILL.md`) `` form; no slash-command syntax.
- **CC plugin** (`public/chorus-plugin/skills/*`) and **Codex plugin** (`plugins/chorus/skills/*`): cross-links use `/chorus` slash form.
- **OpenClaw** (`packages/openclaw-plugin/skills/*`): tool names get the `chorus__` prefix per that root's namespace note; keep bare names in prose with the prefix reminder already present.

### D2 — Guidance content (idea skill)

A compact "External references" subsection placed in the idea workflow (in or right after Step 4 "Gather Context", where the agent is already reading the idea and related material — the natural moment to notice external links). Content:

1. **The reflex.** When you encounter an external link that is evidence for the idea — a precedent issue/PR, a reference implementation, official docs, a paper/blog — attach it as a reference. Prefer attaching **at creation time** via the inline `references[]` param on `chorus_pm_create_idea` (and `chorus_pm_create_proposal` / `chorus_create_tasks`) rather than a post-hoc `chorus_add_reference`.
2. **Four-type selection criteria** (Q4=a):
   - `docs` — official documentation (framework/API/library reference).
   - `repo` — a reference implementation or source repository.
   - `issue_pr` — an issue or pull-request thread (precedent, prior art, the delivering PR).
   - `paper_blog` — a paper or blog post (background, design rationale).
3. **One generic inline example** (Q5=a), public-safe:

   ```
   chorus_pm_create_idea({
     projectUuid: "...",
     title: "Add Portuguese (pt) locale",
     content: "...",
     references: [
       { type: "issue_pr", url: "https://github.com/org/repo/pull/411",
         title: "PR #411 — prior ko locale work (precedent to mirror)" },
       { type: "docs", url: "https://next-intl.dev/docs/routing",
         title: "next-intl routing docs (locale registration)" }
     ]
   })
   ```

### D3 — Guidance content (chorus overview skill)

The chorus skill already lists `chorus_add_reference` / `chorus_update_reference` / `chorus_remove_reference` in a tool table. Add a short behavior note near that table (or the shared-tools/@mention area) that states the reflex in one or two sentences and points to the idea skill for the full type criteria + example — so the overview reinforces the reflex without duplicating the whole block.

### D4 — Wake-prompt nudge (one line each, Q3=a)

Two surfaces, and only two — grep-confirmed:

1. `cli/prompts.mjs` → `HEADLESS_PREAMBLE`. This block is prepended to **every** wake, so a single line here covers all idea/proposal/task wakes at once. Constraint from the file's own header comment: the preamble must NOT embed the literal `chorus_pm_start_elaboration` / `chorus_pm_validate_elaboration` tool names (it rides `elaboration_verified` too). A references nudge is safe — it names `chorus_add_reference` / `references[]`, not the elaboration tools. Add one compact line, keeping the block's terse style.

2. `src/services/daemon-instruction.service.ts` → `composeConversationalIdeaInstruction`. The conversational-idea entry. Add one line to the shared lead-in so both `elaborate` and `decompose` modes carry it, without disturbing the numbered step contract that its unit test asserts.

**Out:** the OpenClaw event-router (`packages/openclaw-plugin/src/event-router.ts`) deliberately has no headless preamble — the CLI↔OpenClaw parity guard (`cli/__tests__/openclaw-plugin-wake-parity.test.mjs`) checks *action coverage only, never prompt text*, and each host keeps its own voice. So OpenClaw is correctly untouched; adding a preamble there would contradict that design decision.

Both prompt bodies are under wording tests (`cli/__tests__/wake-orchestration.test.mjs` asserts specific `HEADLESS_PREAMBLE` substrings; `daemon-instruction.conversational.test.ts` asserts the conversational template). Update the tests to assert the new nudge substring so the wording stays a review-visible, enforced diff.

### D5 — UI overflow fix (root cause + fix)

**Root cause.** In both `references-section.tsx` (~L226) and `idea-references-panel.tsx` (~L63) the reference link is:

```
<a className="inline-flex items-center gap-1 ...">
  <span className="truncate">{ref.title}</span>
  <ExternalLink className="... shrink-0" />
</a>
```

`inline-flex` makes the anchor shrink-wrap to its content width, so it ignores the `min-w-0 flex-1` parent. `truncate` on the inner span needs a bounded width to engage; because the anchor is unbounded, the span grows and a long title/URL overflows the card.

**Fix.** Make the anchor a block-level, width-constrained flex container so the inner span truncates against the card width:

```
<a className="flex min-w-0 items-center gap-1 ...">
  <span className="truncate">{ref.title}</span>
  <ExternalLink className="... shrink-0" />
</a>
```

- `flex` (not `inline-flex`) + `min-w-0` lets the anchor take the parent's width and lets the truncating child shrink below its content size.
- The `ExternalLink` icon keeps `shrink-0` so only the title truncates, icon stays visible.
- The native `title`/hover already exposes the full title; the URL remains reachable via the link. No new i18n strings.

**Verification.** Semantic tokens only — no color change, so both themes are structurally covered; still verify visually in light + dark with a pathologically long title/URL (e.g. a 300-char URL used as the title) that the ellipsis appears and the card does not widen.

## Risks

- **Doc drift across 8 files.** Mitigated by treating the two capabilities as separate tasks and a final code-review gateway over the aggregate diff. The plugin-maintenance skill's guidance on the 4-root sync applies.
- **Wake-prompt token cost.** One line each; the preamble line is the only per-wake cost and is intentionally single-sentence.
- **Test wording lock.** Both prompt tests assert substrings; updating them in the same task as the prompt edit keeps them green and makes the wording change reviewable.
