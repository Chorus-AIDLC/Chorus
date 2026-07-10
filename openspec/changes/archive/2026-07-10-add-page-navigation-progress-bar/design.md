## Context

Chorus dashboard/admin are client-navigated App Router surfaces. The root layout
(`src/app/layout.tsx`) is a Server Component that already wraps children in
`ThemeProvider` (next-themes, `attribute="class"`) then `LocaleProvider`. Dark mode
shipped in 0.14.0: `src/app/globals.css` defines `--primary` under **both** `:root`
(`21 49% 55%` → `#C67A52`) and `.dark` (`22 50% 50%` → `#bf6f40`), consumed everywhere as
`hsl(var(--primary))`. There is no navigation-pending indicator today; `PageTransition`
(`src/components/page-transition.tsx`) only animates the incoming page after it mounts.

Next.js App Router intentionally exposes **no** public "navigation start/stop" event
(the old Pages `Router.events` was removed). Any top-loader for the App Router therefore
works by (a) intercepting `<a>`/`<Link>` clicks and `window.history` (popstate) to detect
start, and (b) wrapping `router.push/replace/...` for programmatic starts, then stopping
when the new pathname/searchParams commit. This is exactly what NProgress-lineage
libraries do; we do not hand-roll it.

## Goals / Non-Goals

**Goals:**
- A slim (3px) top-of-viewport bar that appears on navigation start and completes on
  route commit, across all in-app navigations (Q1=a).
- Indeterminate auto-trickle behavior (Q2=a) — no real-progress measurement.
- Brand-primary color + subtle tail glow (Q3=b), correct in light **and** dark with no
  per-theme JS.
- ~120ms show-delay so fast navigations don't flash (Q4=a).
- A maintained, pure-JS library with no native bindings (Q5=b, pitfall #9).

**Non-Goals:**
- Real/deterministic progress (Q2 rejected b).
- Full-page reload / first-paint indicator (Q1=a, not c) — the browser's own chrome
  covers that.
- Route-specific bar styling, per-navigation opt-out UI, or a visible spinner.
- Any backend, schema, API, permission, or i18n change.

## Decisions

### D1 — Library: `@bprogress/next` (BProgress), not `nextjs-toploader`

Both are NProgress-lineage, pure-JS/TS, no native bindings — either satisfies pitfall #9
and the "mature library" spirit of Q5=b (the user wrote "nextjs-toploader 之类" — *"…and
the like"* — naming the category, not mandating that exact package). The deciding factor
is **Q4=a's show-delay**:

- `nextjs-toploader`'s prop set (`color`, `height`, `crawl`, `crawlSpeed`, `speed`,
  `showSpinner`, `shadow`, `zIndex`, …) has **no delay / debounce** prop. It cannot
  suppress the flash on sub-threshold navigations without patching the library.
- `@bprogress/next` (the maintained successor to `next-nprogress-bar`, TypeScript rewrite
  of NProgress) exposes a first-class **`delay`** prop on both `ProgressProvider` and its
  `useRouter`, plus `stopDelay`, `disableSameURL` (defaults true), `shallowRouting`,
  `startPosition`, `showSpinner`, `color`, `height`, and glow via the injected bar CSS.

So BProgress is the only option in this family that honors Q1=a + Q2=a + Q3=b + Q4=a
together. Choosing it is *more* faithful to the elaboration than taking the literally
named package and dropping the delay requirement. This tradeoff is called out in the
proposal so a reviewer sees it was deliberate, not an accident.

Add `@bprogress/next` (which pulls `@bprogress/core`). Both are pure JS.

### D2 — Mount `ProgressProvider` in the root layout, inside `ThemeProvider`

In `src/app/layout.tsx`, wrap the app in `ProgressProvider` from `@bprogress/next/app`.
Placement: **inside** `<ThemeProvider>` (so any theme context is available) and around
`LocaleProvider` + `children`. `ProgressProvider` is a client component; the root layout
stays a Server Component (importing a client component into a server component is fine —
same as the existing `ThemeProvider`/`LocaleProvider` usage). It renders the bar element
into the body and installs the anchor/history listeners.

Config:
```tsx
<ProgressProvider
  height="3px"
  color="hsl(var(--primary))"
  delay={120}
  options={{ showSpinner: false }}
  shallowRouting
>
```
- `disableSameURL` defaults to `true` — same-URL clicks won't flash the bar (required by
  the spec's "same URL" scenario). `shallowRouting` keeps shallow `?panel=`/query updates
  from spuriously triggering it where the pathname is unchanged.

### D3 — Theming with the design token, not a hardcoded hex (zero per-theme JS)

Pass `color="hsl(var(--primary))"`. BProgress writes the bar/peg color from the `color`
prop into its injected stylesheet, and the peg **glow** (the Q3=b "微光" tail) is derived
from that same color by default — so one token drives bar + glow. Because `--primary` is
already redefined under `.dark`, the CSS variable resolves to the light or dark terracotta
automatically when next-themes toggles the `.dark` class — **no `useDarkClass`, no
MutationObserver, no per-theme prop switching**. This follows the project's dark-mode
rule "use the library's own theming API rather than fighting injected CSS," and the
lesson that a saturated brand color needs a dark-tuned value — which `.dark`'s
`--primary` (`#bf6f40`) already provides.

> Verify at build time that BProgress's injected CSS uses the `color` value verbatim
> (i.e. accepts a `hsl(var(--x))` string, not only `#hex`). If a raw CSS function string
> is not honored in the box-shadow glow, fall back to overriding `#bprogress .bar` /
> `.peg` `background`/`box-shadow` in `globals.css` with `hsl(var(--primary))` and pass a
> transparent/placeholder `color` — the token path is the goal either way. This is the
> one integration risk and the e2e task must confirm the dark bar is the dark terracotta,
> not the light one.

### D4 — Programmatic navigation coverage via a wrapper `useRouter`

The provider auto-covers `<Link>`/anchor clicks and browser back/forward (history). It
does **not** intercept programmatic `router.push/replace/back/forward` from
`next/navigation`'s `useRouter`. To honor Q1=a ("all in-app navigations"), provide a thin
wrapper and swap imports:

- New `src/hooks/use-progress-router.ts`: `export { useRouter } from "@bprogress/next/app";`
  — optionally wrapping to bake `{ delay: 120 }` defaults so call sites stay unchanged
  beyond the import path. BProgress's `useRouter` returns the same
  `push/replace/back/forward/refresh/prefetch` surface as `next/navigation`, so call
  sites need no signature change.
- Replace `import { useRouter } from "next/navigation"` with the wrapper in the client
  components that navigate programmatically (~41 files, ~61 call sites; enumerate with
  `grep -rl 'useRouter' src | xargs grep -l 'next/navigation'`). Leave `usePathname` /
  `useSearchParams` / `useParams` imports from `next/navigation` untouched — only
  `useRouter` moves.
- **Do not** blanket-swap files that import `useRouter` but never call a navigation method
  (rare, but check) — no harm, but keep the diff honest.

### D5 — Keep it out of the SSR/first-paint path

The bar is client-only navigation feedback; it must not run on full reload/first load
(Q1=a). `ProgressProvider` naturally only fires on client navigations after hydration, so
no extra guard is needed. No `startOnLoad`.

### D6 — Tests

Client components that switch to the wrapper currently do `vi.mock("next/navigation")`
returning a fake `useRouter`. After the swap those mocks must target the wrapper module
(or `@bprogress/next/app`) so `router.push` is still a spy. Add/adjust mocks per touched
test file; the acceptance bar is the existing suite passing (`pnpm test`), plus
`pnpm lint`, `npx tsc --noEmit`, and `pnpm build` clean.

## Risks / Trade-offs

- **`hsl(var(--primary))` in the glow box-shadow** may not be honored by the library's
  injected CSS in every position → mitigated by the D3 fallback (override the bar/peg CSS
  in `globals.css`) and confirmed in the e2e task in both themes.
- **41-file import swap** is broad but mechanical and low-risk (identical return surface).
  The main hazard is missed test mocks → caught by `pnpm test`. Keeping `usePathname`
  etc. on `next/navigation` limits blast radius.
- **Library choice deviates from the literally-named package** → documented in proposal
  D1 as a deliberate, more-faithful reading of the combined elaboration answers; a
  reviewer can veto and fall back to `nextjs-toploader` + a hand-rolled delay if they
  disagree.
- **design.pen** update needs the Pencil GUI → GUI-blocked in headless; that AC is
  non-required and handed to a human, not blocking the pipeline.
