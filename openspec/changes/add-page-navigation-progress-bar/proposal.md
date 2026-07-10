# Proposal: Top-of-page navigation loading progress bar

## Why

Chorus is an App Router SPA. When a user navigates (sidebar link, project/idea card,
breadcrumb, back/forward), Next.js must fetch the route's RSC payload and any code
chunks before the new screen paints. On a slow link that produces a visible pause of a
few hundred milliseconds during which **nothing on screen changes** — the app looks
frozen and the user cannot tell whether their click registered. The reported symptom is
exactly this: "页面切换的时候由于要加载资源，会卡顿，但没有明显反馈".

There is no navigation-pending affordance today. `PageTransition` only animates the
*new* page in **after** it has loaded; it gives no feedback during the wait itself.

This change adds a slim top-of-viewport loading bar (YouTube / NProgress style) that
appears when a navigation starts and smoothly completes when the new route is ready,
turning the silent pause into an unmistakable "working…" signal.

## What Changes

- **A slim progress bar pinned to the very top of the viewport**, above all app chrome,
  driven by App Router navigation lifecycle.
- **Behavior = indeterminate auto-trickle** (elaboration Q2=a): on navigation start it
  jumps to an initial position and crawls toward ~90%, then snaps to 100% and fades out
  when the route is ready. No attempt to measure true byte progress (App Router / RSC
  streaming can't be measured precisely, and the user chose the reliable classic).
- **Scope = every in-app navigation** (Q1=a): `<Link>` clicks, programmatic
  `router.push` / `replace` / `back` / `forward`, and browser back/forward. Same-URL
  navigations do not trigger it. Full-page reload / first load is out of scope (the
  browser already shows its own load indicator; Q1=a, not Q1=c).
- **Visual = 3px bar in the brand primary color with a subtle tail glow** (Q3=b), and it
  **adapts to light and dark themes automatically** by using the `--primary` design token
  (already defined for both themes) rather than a hardcoded hex.
- **A short show-delay (~120ms)** (Q4=a): navigations that resolve faster than the delay
  never flash the bar, so instant page switches stay calm; only genuinely slow ones show
  feedback.
- **Implementation = the maintained pure-JS library `@bprogress/next` (BProgress)**
  (Q5=b). See the design doc for why BProgress over `nextjs-toploader` — BProgress is the
  same NProgress-lineage, no-native-bindings option but is the one that exposes a native
  `delay` prop, which Q4=a requires. `nextjs-toploader` cannot honor the show-delay.

**Non-breaking**: purely additive UI feedback. No route, data, auth, schema, or API
change. If the bar were removed the app would behave exactly as today.

## Capabilities

### New Capabilities

- `page-navigation-progress`: the top-of-page navigation loading indicator — when it
  appears, what it looks like, which navigations trigger it, its show-delay, and its
  light/dark theme adaptation.

### Modified Capabilities

<!-- none — no existing capability's requirements change -->

## Impact

- **Dependencies**: add `@bprogress/next` (pure TS, no native bindings — satisfies
  cross-platform pitfall #9). It depends on `@bprogress/core`, also pure JS.
- **Frontend code**:
  - `src/app/layout.tsx` — mount BProgress's `ProgressProvider` inside `<body>` (inside
    the existing `ThemeProvider` so `hsl(var(--primary))` resolves per active theme),
    configured with height, themed color, glow, `showSpinner: false`, and `delay`.
  - New thin wrapper hook (e.g. `src/hooks/use-progress-router.ts`) re-exporting
    BProgress's App-Router `useRouter` with the project's `delay` baked in, so
    programmatic navigations get the same behavior without every call site repeating
    options.
  - Swap `import { useRouter } from "next/navigation"` → the wrapper across the client
    components that navigate programmatically (~41 files), so `router.push`/`replace`/
    `back` also drive the bar. `<Link>` and back/forward are covered by the provider with
    no per-site change.
- **i18n**: none — the bar has no visible text or accessible label content (it is
  decorative `aria-hidden` progress); nothing to translate.
- **Test impact**: components currently rely on `vi.mock("next/navigation")` for
  `useRouter`. Files switched to the wrapper must have their mocks retargeted (mock the
  wrapper or `@bprogress/next/app`) so the existing suite stays green.
- **Docs / design**: `docs/design.pen` gets a frame showing the top progress bar (Pencil
  MCP; GUI-blocked in a headless run and handed to a human — that AC is non-required).
- **No backend / API / schema / permission / migration changes.**
- **Backward compat**: fully additive; nothing changes for any existing flow.
