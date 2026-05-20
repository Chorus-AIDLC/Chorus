# Render mermaid code blocks in Chorus documents

## Why

Chorus' Document/Proposal rendering pipeline (`streamdown` + `shiki`) handles
prose and code blocks but ignores ` ```mermaid ` blocks — they fall through
the standard code path and render as plain text. Architecture diagrams,
sequence diagrams, and state machines are everyday vocabulary in AI-DLC
artifacts; agents currently have to fall back to ASCII art or external
images, breaking the "Document is the source of truth" story.

Streamdown 2.x already split mermaid support into a separate plugin
(`@streamdown/mermaid`); enabling it is the obvious fix and matches the
pattern used in `strands-ai-sdk` (commit `45b09ea6`).

While we're touching the rendering stack, we'll also bump `shiki` from
3.23 to 4.x — current major. This trims the call surface of the upgrade
to a single, contained change and avoids a second round-trip through the
~14 `<Streamdown>` call sites.

## What Changes

- Add `@streamdown/mermaid` dependency and bump `streamdown` to `^2.5.0`.
- Bump `shiki` from `3.23.0` to `^4.1.0`.
- Introduce `src/lib/streamdown-plugins.ts` exporting a `streamdownPlugins`
  object (`{ code, mermaid }`) and a `streamdownControls` object enabling
  `fullscreen`, `download`, `copy`, and `panZoom` on the mermaid block.
- Collapse the ~14 direct `<Streamdown plugins={{ code }}>` call sites into
  the existing `<MarkdownContent>` component, which becomes the single
  consumer of `streamdownPlugins` / `streamdownControls`.
- Wire mermaid theme to Chorus' light/dark theme — pass `default` / `dark`
  to mermaid initialization and re-render on theme change.
- Tailwind config already scans `streamdown/dist` via the `@source`
  directive in `globals.css`; verify it covers `@streamdown/mermaid`'s
  compiled output too and extend if needed.

## Capabilities

- `document-markdown-rendering` — new capability covering how Chorus
  renders Markdown content in documents, proposals, ideas, tasks, and
  comments. The mermaid behavior lands as the first ADDED requirement.

## Impact

- **Affected code:**
  - `package.json`, `pnpm-lock.yaml`
  - `src/lib/streamdown-plugins.ts` (new)
  - `src/components/markdown-content.tsx` (becomes the canonical renderer)
  - 13 other `.tsx` files that currently call `<Streamdown plugins={{ code }}>`
  - `src/app/globals.css` (potentially extend `@source` to cover
    `@streamdown/mermaid`)
- **No data model changes**, no API surface changes, no schema migration.
- **Bundle size:** mermaid + d3 are ~250KB gzipped. We accept the cost;
  the plugin uses `IntersectionObserver` for lazy render so off-screen
  diagrams don't pay the parse/render cost.
- **Cross-platform:** mermaid is pure JS, no native bindings — clears
  CLAUDE.md rule 9.
- **Out of scope:** PDF/HTML export with embedded mermaid (Chorus has no
  export feature today), bundle splitting via dynamic import.
