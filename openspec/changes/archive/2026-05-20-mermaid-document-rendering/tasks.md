# Tasks — mermaid-document-rendering

> Source of truth lives in Chorus task drafts created via
> `chorus_pm_add_task_draft`. This file mirrors the same task list for
> readers browsing `openspec/changes/<slug>/` directly.

1. Bump streamdown / shiki and add @streamdown/mermaid
   - update package.json: `streamdown ^2.5.0`, `shiki ^4.1.0`,
     `@streamdown/mermaid ^1.0.2`
   - run `pnpm install`, verify lockfile only changes the three deps
   - confirm `pnpm dedupe` shows a single shiki resolution

2. Create the shared `streamdown-plugins` module
   - new file `src/lib/streamdown-plugins.ts`
   - export `streamdownPlugins = { code, mermaid }`
   - export `streamdownControls.mermaid = { fullscreen, download, copy,
     panZoom }`

3. Refactor `MarkdownContent` to be the canonical renderer
   - import shared `streamdownPlugins` / `streamdownControls`
   - read Chorus theme (next-themes if present, else DOM-class hook)
   - pass theme into `controls.mermaid.theme` (default | dark)
   - keep streaming + plain code path working

4. Migrate all 14 `<Streamdown>` call sites to `<MarkdownContent>`
   - delete per-file `import { Streamdown }` and `import { code }`
   - replace JSX with `<MarkdownContent>{...}</MarkdownContent>`
   - special-case `mention-renderer.tsx` — preserve placeholder paths

5. Ensure Tailwind v4 scans the mermaid plugin's compiled output
   - verify whether existing `@source` glob covers
     `@streamdown/mermaid/dist`; extend if not
   - manual check: open a doc with a mermaid block, confirm the
     toolbar buttons are clickable (Tailwind classes resolved)

6. Smoke test on local Chorus via Playwright
   - dev server (`pnpm dev`), log in, navigate to a Document with a
     mermaid block (create one for the test if none exist)
   - verify SVG renders, toolbar buttons clickable, fullscreen works
   - toggle theme, confirm mermaid re-renders in dark palette
