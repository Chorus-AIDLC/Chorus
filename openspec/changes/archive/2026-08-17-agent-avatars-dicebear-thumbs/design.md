## Context

Today every agent is rendered as a Lucide `Bot` glyph inside a square whose background is derived from `getAgentColor(agentName)` — a 32-bit char-code hash of the **name** mapped onto a 12-color palette (`src/lib/agent-color.ts`). The shared shadcn `<Avatar>` exists (`src/components/ui/avatar.tsx`) and even exports `<AvatarImage>`, but `<AvatarImage>` is **never used** — no image is ever loaded. `User.avatarUrl` exists in the schema but is never rendered. Agent-vs-user branching is driven by `src/lib/assignee-identity.ts` (`isAgentAssignee`, etc.) and by `author.type === "agent"` / `item.type === "agent"` at each call site.

Because there is no stored agent image, avatars must be **generated at render time from data already present** at each site. The only reliably-present identifier across all sites is the agent **name** (and sometimes uuid). The elaboration locked seed = **name**, which keeps the new avatar consistent with the existing `getAgentColor` hue (same seed → coordinated color + face).

## Goals / Non-Goals

**Goals:**
- One shared `<AgentAvatar>` component that is the single source of agent-avatar rendering; every current `Bot`-glyph agent surface routes through it.
- Deterministic, offline, per-name DiceBear Thumbs (animated) avatars.
- Always-animating by default, with a `prefers-reduced-motion` static fallback.
- Add avatars to the three surfaces that lack them (create/onboard preview, cwd pin hover, daemon chat header).
- Work correctly in **both** light and dark themes.

**Non-Goals:**
- **No user (human) avatars this round** — users keep initials/`User` icon. `User.avatarUrl` stays untouched.
- No reroll / shuffle, no per-agent avatar customization UI, no stored `avatarSeed` field.
- No schema/DB/API change, no Prisma migration.
- Not changing the agent-vs-user distinction logic (agents get avatars; users don't — the distinction is inherent).

## Decisions

### D1 — Generate locally with `@dicebear/core` + `@dicebear/styles` (not the hosted HTTP API)
Bundle the library and generate the SVG in-process. Rationale: Chorus is published to npm and self-hosted; the hosted `api.dicebear.com` endpoint would add an external network dependency, a privacy surface (agent names leaving the deployment), and an availability/offline failure mode. Both packages are pure JS (no native bindings) — compatible with the linux-x64/arm64, darwin, Windows publish targets. **Alternative rejected:** `<img src="https://api.dicebear.com/10.x/thumbs/svg?seed=...">` — simplest but violates the offline/no-external-dep constraint.

### D2 — Seed = agent **name**
Seed the avatar from the agent name, matching `getAgentColor`'s existing input. Rationale: (a) it is present at every render site with zero plumbing; (b) color and face derive from the same seed and stay visually coordinated; (c) it matches the owner's explicit choice. **Accepted trade-off:** renaming an agent changes its avatar, and two same-named agents collide — acceptable per elaboration. **Alternative rejected:** seeding by uuid (stable across rename) — not chosen because uuid is not present at all call sites and would decouple face from the name-hashed color.

### D3 — `<AgentAvatar>` API and rendering
Add `src/components/ui/agent-avatar.tsx`:

```
<AgentAvatar name={string} size?={"xs"|"sm"|"md"|"lg" | number} animate?={boolean} className?={string} />
```

- Internally wraps the existing shadcn `<Avatar>` + `<AvatarImage>` (finally using `AvatarImage`), with an initial/`Bot` `<AvatarFallback>` for the pre-hydration / generation-error path.
- Generates the SVG once via DiceBear, converts to a data URI, and feeds it to `<AvatarImage src>`.
- **Memoize** generation by `(name, animate)` (module-level `Map` cache) so re-renders and repeated names don't re-run generation.
- Sizes map to fixed px (xs≈20, sm≈24, md≈32, lg≈40) to match the squares they replace.

### D4 — Animation: always-on, `prefers-reduced-motion` fallback
DiceBear v10 Thumbs is one of the animated styles: the animation is a CSS loop embedded in the SVG. Default `animate = true` → generate the animated form. When `window.matchMedia("(prefers-reduced-motion: reduce)").matches`, generate the **static** form instead. This is an accessibility default and does not change the product intent ("always animate").

> **Hallucination-aware / version-pinning directive (read before coding — this is the feature's linchpin):** DiceBear's API changed across majors. This design targets **v10** (`@dicebear/core` exposing `new Style(definition)` / `new Avatar(style, options)` with `.toString()`; style definition imported from `@dicebear/styles/thumbs.json`; HTTP API path `10.x`). **How to turn animation on/off is genuinely ambiguous between DiceBear's own sources** and MUST be resolved against the *installed* package, not memory or docs prose:
> - One reading (DiceBear "animated-avatars" page): animation is a variant option — pick a speed (slowest→fastest) to animate, omit it for static.
> - Another reading (style docs / proposal review): the on/off switch is the option `tags: ['animation']` (animate) vs `tags: ['!animation']` (static), while `animationVariant` only selects speed.
> Before coding, **inspect `node_modules/@dicebear/styles/thumbs.json`'s `animation` variant definition and the installed `@dicebear/core` types** to determine the real enable/disable mechanism and the static form to use for the reduced-motion path. Also confirm the constructor/factory (`new Style`/`new Avatar` vs the older `createAvatar(collection.thumbs, …)`), the seed option, and whether a `toDataUri()` helper exists (else build the data URI from `.toString()` via `encodeURIComponent`).

### D5 — Comprehensive sweep via the shared component (agents only)
Every site that currently renders a **specific agent's identity** as a `Bot` glyph (or a name-only text row where an avatar belongs) is changed to render `<AgentAvatar>`; **user** initial/`User`-icon rendering is left exactly as-is. Where a site mixes agents and users (comments, assignees, @mention picker), keep the existing `isAgentAssignee` / `author.type === "agent"` branch and only swap the agent branch. The `<canvas>` mindmap ring (`mindmap-canvas.tsx`) cannot mount a React component; there, keep the existing `getAgentColor` ring (out of scope for an inline avatar) OR render the avatar in the surrounding DOM overlay if one exists — best-effort, document whatever is done. Raw-DOM sites (`mention-editor.tsx` builds avatar markup as HTML strings) may need a small refactor to mount the React avatar or to inline the generated SVG string.

**Full surface list (agent-identity sites — result of a two-agent sweep, Admin Claude + Codex👷):**
- *Comments & assignees:* `unified-comments.tsx`; `ideas/idea-detail-panel.tsx`; `tasks/task-detail-panel.tsx` (assignee **and** Active Workers); `tasks/kanban-board.tsx` (card assignee **and** blocker dialog); `tasks/task-view-toggle.tsx` list cards; `dashboard/panels/assignee-section.tsx`; `dashboard/panels/task-list-view.tsx`.
- *Assign / mention:* `assign-task-modal.tsx`; `ideas/assign-idea-modal.tsx`; **`components/assign-modal.tsx`** (the generic AssignModal used by task-actions — a separate file); `mention-editor.tsx` (@mention picker); **`agent-presence/mention-badge.tsx`** (the interactive rendered @agent chip in comment bodies — badge **and** popover identity header).
- *Proposal creator:* `proposals/proposal-kanban.tsx` (card creator); `proposals/[proposalUuid]/page.tsx` creator — **keep ONE identity presentation** (top OR metadata, not both) to avoid a duplicate on-screen avatar.
- *Presence / connections:* `agent-presence/presence-roster.tsx`, `instance-group.tsx`, `identity-block.tsx`, `daemon-presence-entry.tsx`; **`agent-presence/connections-view.tsx`** (desktop rail + mobile connection card); `ui/presence-indicator.tsx` (`AgentBadge`); `graph/mindmap-canvas.tsx` (best-effort per above).
- *Daemon chat:* `agent-presence/chat/message.tsx` (message header); the **agent selector** in `agent-presence/chat/conversation-list.tsx` **and** `agent-presence/conversational-entry.tsx` — put the avatar on the *selector* (the real distinct-identity point); do **not** duplicate a per-row avatar since rows are already filtered by the selected agent.
- *Settings / project config:* `settings/page.tsx` API-key list icon — **seed by the owning agent's display name** (`settings/actions.ts` already returns `key.agent?.name`; rename syncs), **not** the key prefix; **`components/project-agent-cwd-settings.tsx`** (per-row agent+cwd identity); `dashboard/project-cwd-summary.tsx` (cwd pin hover).
- *Create / onboarding:* `AgentCreateForm.tsx` + `onboarding/components/CreateAgentStep.tsx` (live preview); **`onboarding/components/TestConnectionStep.tsx`** (waiting-for-agent) + **`onboarding/components/CompletionStep.tsx`** (created-agent summary) — reuse the same create-preview avatar for visual continuity.

**Deliberately excluded** (semantic/decorative — NOT a specific agent; a DiceBear avatar there would fabricate an identity): admin "Total Agents" KPI stat-card icons (`admin/page.tsx`, `admin/companies/[uuid]/page.tsx`); the projects onboarding "admin-agent tip" card icon (`projects/page.tsx`); the elaboration empty-state illustration Bot (`dashboard/panels/elaboration-view.tsx` — "not started" / "agent working").

**Out of scope this round (owner-deferred, recommended follow-up):** activity-feed actor avatars (`activity-timeline.tsx`, `idea-tracker-stats.tsx`) and notification actor avatars (`notification-popup.tsx`) — these are text-only today, so it is a *new* actor-avatar surface (affecting all actor types incl. users), not a Bot→avatar replacement.

### D6 — Theme correctness
DiceBear Thumbs draws on its own tinted background, so it is theme-agnostic, but the **container** (ring, border, fallback bg) must use semantic tokens (`bg-muted`, `border-border`, etc.) and be verified in both light and dark. No hardcoded hex.

## Risks / Trade-offs

- [DiceBear v10 API uncertainty] → D4's pinning directive; developer verifies constructor + animation option against the installed version before coding.
- [Many simultaneous looping SVGs on comment/kanban pages hurt perf or distract] → Owner chose always-on; mitigate with the memo cache (one generation per name) and the `prefers-reduced-motion` fallback. If profiling shows jank, a follow-up idea can add hover-only/entrance modes — not in scope now.
- [Raw-DOM / canvas sites (`mention-editor.tsx`, `mindmap-canvas.tsx`) don't take a React child] → allow inlining the generated SVG string, or scope those to best-effort with a documented note; don't block the sweep on them.
- [Bundle size from bundling a style] → only the Thumbs definition + core are needed; acceptable. Verify no accidental import of the entire `@dicebear/styles` collection.
- [SSR / hydration] → generation is deterministic, so server and client produce the same SVG; the `prefers-reduced-motion` check is client-only, so render animated on the server and let the client swap to static if needed (guard against a hydration mismatch by gating the reduced-motion read to `useEffect`/first client render).

## Migration Plan

Pure additive frontend change. No migration, no rollback data concern. Deploy is a normal build; if reverted, sites fall back to the prior `Bot` glyph. Land the shared component first, then sweep surfaces, then the new-surface additions, then an integration/verification pass.

## Open Questions

- None blocking. (Mindmap-canvas ring treatment is left to implementer discretion per D5, documented in that task.)
