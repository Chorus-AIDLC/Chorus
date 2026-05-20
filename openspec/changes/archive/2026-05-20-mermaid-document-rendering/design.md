# Tech Design — Mermaid in Chorus documents

## Background

`streamdown` is Chorus' streaming Markdown renderer (drop-in replacement
for `react-markdown`, designed for token-by-token AI streams). In v1
mermaid was built in; v2 (`2.4.0+`) split it into `@streamdown/mermaid`
and stopped enabling it by default. Chorus shipped 2.4 already in package.json,
but never wired the new plugin — hence mermaid blocks render as plain code.

The reference implementation we're following is `strands-ai-sdk`
commit `45b09ea6eaa40e57b423a108c8756c67e3eea037` ("Restore mermaid
rendering after Streamdown v2 upgrade"). It does three things we need to
replicate:

1. Add `@streamdown/mermaid` and pass it through every `<Streamdown>`
   call site as a plugin, with `controls={{ fullscreen, download, copy,
   panZoom }}`.
2. Centralize the plugin/control objects in a shared module so call
   sites stay terse and stay consistent on later upgrades.
3. Add `streamdown/dist` (and `@streamdown/<plugin>/dist`) to the
   Tailwind content globs — streamdown ships pre-compiled JSX with
   Tailwind utility classes (e.g. `min-h-[200px]`,
   `pointer-events-auto`) that the JIT will not see otherwise; missing
   them means the mermaid container collapses to height 0 and the
   toolbar becomes unclickable.

Chorus uses Tailwind v4 with `@import "tailwindcss"` in `globals.css`
and the `@source` directive (already pointing at
`../../../node_modules/streamdown/dist/*.js`). We'll need to verify
that glob also catches `@streamdown/mermaid`'s compiled output; if not,
extend it.

## Module structure

### `src/lib/streamdown-plugins.ts` (new)

```ts
"use client";

import { code } from "@streamdown/code";
import { mermaid } from "@streamdown/mermaid";

export const streamdownPlugins = { code, mermaid } as const;

export const streamdownControls = {
  mermaid: {
    fullscreen: true,
    download: true,
    copy: true,
    panZoom: true,
  },
} as const;
```

This is a client-only module (the plugins drag in `useEffect` /
`IntersectionObserver`); we mark it `"use client"` so any server
component import surfaces immediately as a build error rather than at
runtime.

### `src/components/markdown-content.tsx` (modified)

Becomes the single rendering entry point used by every Markdown surface
in the app. Today it already calls `<Streamdown plugins={{ code }}>`;
we extend it to forward both `plugins` and `controls` from the shared
module, plus a `theme` derived from the active Chorus theme.

```ts
"use client";

import { Streamdown } from "streamdown";
import { useTheme } from "next-themes";
import { useMemo } from "react";

import {
  streamdownPlugins,
  streamdownControls,
} from "@/lib/streamdown-plugins";

export function MarkdownContent({ children }: { children: string }) {
  const { resolvedTheme } = useTheme();
  const controls = useMemo(
    () => ({
      ...streamdownControls,
      mermaid: {
        ...streamdownControls.mermaid,
        theme: resolvedTheme === "dark" ? "dark" : "default",
      },
    }),
    [resolvedTheme],
  );

  return (
    <Streamdown plugins={streamdownPlugins} controls={controls}>
      {children}
    </Streamdown>
  );
}
```

> Note: `@streamdown/mermaid`'s control schema accepts an optional
> `theme` that maps directly to mermaid's `themeVariables` selector.
> Chorus' `next-themes` is already in the dependency tree (verify in
> implementation; if not, the alternative is `useResolvedTheme` from
> Chorus' own LocaleProvider style).

### Migration across the ~14 call sites

Every existing call site of the form

```tsx
<Streamdown plugins={{ code }}>{content}</Streamdown>
```

becomes

```tsx
<MarkdownContent>{content}</MarkdownContent>
```

The 14 files (per `grep -rn 'Streamdown' src --include='*.tsx'`):

```
src/components/mention-renderer.tsx                         (2 sites)
src/app/onboarding/components/CodeBlock.tsx
src/app/(dashboard)/projects/[uuid]/ideas/ideas-list.tsx
src/app/(dashboard)/projects/[uuid]/ideas/idea-detail-panel.tsx
src/app/(dashboard)/projects/[uuid]/dashboard/panels/document-panel.tsx
src/app/(dashboard)/projects/[uuid]/dashboard/panels/elaboration-view.tsx
src/app/(dashboard)/projects/[uuid]/dashboard/panels/basic-view.tsx
src/app/(dashboard)/projects/[uuid]/dashboard/panels/proposal-view.tsx
src/app/(dashboard)/projects/[uuid]/proposals/[proposalUuid]/task-draft-detail-panel.tsx (2 sites)
src/app/(dashboard)/projects/[uuid]/proposals/[proposalUuid]/proposal-editor.tsx
src/app/(dashboard)/projects/[uuid]/proposals/proposal-kanban.tsx
src/app/(dashboard)/projects/[uuid]/documents/[documentUuid]/document-content.tsx
src/app/(dashboard)/projects/[uuid]/tasks/task-detail-panel.tsx (2 sites)
```

`mention-renderer.tsx` is the trickiest case — it pre-processes mentions
into placeholders and currently renders Streamdown directly twice. The
refactor replaces both with `<MarkdownContent>` and keeps the placeholder
pre-processing in place.

## Bundle considerations

`@streamdown/mermaid` is ~80KB gzipped on its own; the `mermaid` core
adds another ~170KB. We're keeping the plugin static-imported (matches
the reference commit) because:

- `@streamdown/mermaid` already gates rendering with
  `IntersectionObserver` — off-screen blocks pay only the JS parse
  cost, not the diagram render cost.
- Chorus is dashboard-style; first paint is dominated by data fetch,
  not bundle size, on every page that ships Markdown.
- Dynamic import would require either (a) detecting mermaid blocks
  before deciding whether to load the plugin (defeats streaming
  semantics) or (b) loading on every Markdown surface anyway (doesn't
  save anything).

If/when bundle becomes a concern we can revisit with route-level code
splitting; that's a separate change.

## Tailwind v4 content scanning

Chorus' `globals.css` has

```css
@source "../../../node_modules/streamdown/dist/*.js";
```

This glob catches `streamdown` itself but not nested packages. We'll
add a second `@source` line covering `@streamdown/mermaid/dist/*.js`
once the package is installed and we can confirm its compiled output
location.

```css
@source "../../../node_modules/@streamdown/mermaid/dist/*.js";
```

The reference repo did this in `tailwind.config.js` using `content`
globs; the v4 equivalent is `@source` in CSS, which is what Chorus
already uses.

## Theme sync

Mermaid initialization happens once per `<Streamdown>` render under
`@streamdown/mermaid`. Re-rendering on theme change is automatic
because we pass `controls.mermaid.theme` derived from
`resolvedTheme` — when `next-themes` flips, the memoized `controls`
object identity changes, React re-renders Streamdown, and the plugin
re-initializes mermaid with the new theme.

If `next-themes` is not already a dependency, the fallback is to read
Chorus' theme from the same source the rest of the app uses (Tailwind
`dark:` classes hang off `<html class="dark">`, so a tiny
`useDarkClass()` hook reading `document.documentElement.classList`
also works).

## Risks

- **Streamdown 2.5 minor version drift.** The reference commit was on
  2.5.0; we'll pin to `^2.5.0` and run the existing test suite plus
  manual smoke. No behavioral changes documented in the 2.4 → 2.5
  changelog beyond the mermaid plugin uptake.

- **Shiki 3 → 4 grammar deprecations.** Shiki v4 dropped some legacy
  grammar names. Chorus' `@streamdown/code` plugin is the consumer;
  if it pins shiki internally, our top-level bump may conflict.
  Mitigation: verify pnpm dedupe shows a single shiki resolution after
  install; if not, override or wait on `@streamdown/code` to bump.

- **next-themes integration.** If next-themes isn't already wired,
  fall back to a small DOM-class observer hook. Cost: ~10 lines, no
  new deps.

- **mention-renderer regression.** The two-render-path code in
  `mention-renderer.tsx` exists for a reason (mention placeholder
  substitution before vs after render). Refactor must preserve both
  paths — the `<Streamdown>` children stay the same, only the
  component identity changes.

## Out of scope

- PDF / HTML export with embedded mermaid (Chorus has no export
  feature today).
- Bundle code-splitting via dynamic import.
- Custom mermaid error UI (we accept `@streamdown/mermaid`'s default:
  error message + raw code block).
- New mermaid block UX features (e.g. inline edit, export to PNG)
  beyond what the upstream controls provide.
