# Proposal: Clamp reference notes to 2 lines with hover tooltip + tap-to-expand; nudge agents to concise notes

## Why

The first-class external-reference feature (ReferenceArtifact) stores an optional `notes` field — a human/agent-authored summary of why a link is relevant. In practice, agents write long, paragraph-length `notes`. Today those render as an **un-clamped `<p>`** in every reference list, so a single verbose reference can dominate the card and push everything else out of view, hurting the scannability the reference list exists to provide.

Two complementary fixes:

1. **Display-side:** clamp the visible `notes` to 2 lines everywhere it renders, with the full text still reachable — hover tooltip on desktop, tap-to-expand inline (which also works on touch, where hover never fires).
2. **Authoring-side:** reword the MCP `notes` parameter docs (`.describe(...)`) so agents are reminded, at write time, to keep each reference's intro to one concise sentence (~200 characters / about two lines).

The stored text is never altered — this is a display clamp plus a documentation nudge. Elaboration resolved (1 round, 4 questions): **all surfaces / docs-only soft nudge / ~200-char target / tap-to-toggle mobile fallback**.

## What Changes

- **New shared `ReferenceNotes` component** renders the `notes` text with `line-clamp-2`, a desktop hover tooltip carrying the full text, and click/tap to expand-and-collapse inline. Empty/null notes render nothing and expose no interaction.
- **Both reference-list surfaces adopt it** — the editable `ReferencesSection` (idea / proposal / task detail panels) and the read-only `IdeaReferencesContent` (dashboard idea-card), replacing their identical inline `<p>{ref.notes}</p>`.
- **MCP `notes` param docs reworded** in all four occurrences (shared inline `referenceInlineItemSchema`, `chorus_add_reference`, `chorus_update_reference`) to nudge a single concise sentence (~200 chars / ≤2 lines).
- **`docs/MCP_TOOLS.md`** `notes` rows updated to match the new wording.
- **i18n** — any new user-facing string (e.g. an expand/collapse aria-label) is added to all four locales (`en`, `zh`, `ja`, `ko`).

Out of scope (per elaboration): no DB change, no `notes` length validation / server-side cap (`z.string()` stays unbounded), no reference section on Documents (they have none).

## Capabilities

- **reference-display** (MODIFIED) — add the 2-line clamp + full-text reveal (hover tooltip + tap-to-expand) to the `notes` text on all reference-list surfaces, alongside the existing title-truncation requirement.
- **reference-association-guidance** (MODIFIED) — the MCP `notes` parameter documentation nudges agents toward one concise sentence, extending the existing reference-attachment guidance to cover *how long* a note should be.

## Impact

- Affected code:
  - `src/components/reference-notes.tsx` (new shared component)
  - `src/components/references-section.tsx` (use it)
  - `src/app/(dashboard)/projects/[uuid]/dashboard/idea-references-panel.tsx` (use it)
  - `src/mcp/tools/pm.ts` (3 `notes` describe strings)
  - `src/mcp/tools/public.ts` (1 `notes` describe string)
  - `docs/MCP_TOOLS.md` (notes rows)
  - `messages/{en,zh,ja,ko}.json` (only if a new key is introduced)
- No schema, migration, or API-contract change. Behavior is display + docs only; both light and dark themes must remain correct.
