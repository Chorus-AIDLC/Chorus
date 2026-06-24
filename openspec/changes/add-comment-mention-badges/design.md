# Technical Design: Comment Mention Badges

## Overview

Upgrade agent `@mentions` in the comment area from static text spans into interactive,
online-aware badges. Clicking a badge opens a popover with the agent/instance identity and
an owner-only, online-only "Open conversation" button that opens the existing daemon chat.

The work is almost entirely frontend. It composes three already-shipped subsystems:

- **Mention token + pin codec** — `@[Name](agent:uuid?cwd=…&host=…)` parsed via
  `decodePinSuffix` (`src/lib/mention-format.ts`); server side already understands this
  (`MentionRef.pinnedHost/pinnedCwd` in `src/services/mention.service.ts`).
- **Presence** — `AgentPresenceProvider` (`src/contexts/agent-presence-context.tsx`)
  exposes `connections: ConnectionView[]` (`{ agentUuid, host, cwd, effectiveStatus,
  lastSeenAt, … }`), polled from `/api/agent-connections`, and `setOpenSession`.
- **Daemon chat** — `DaemonChat` (`src/components/agent-presence/chat/daemon-chat.tsx`),
  rendered inside the presence modal (`modalOpen` / `setModalOpen`), reads `connections`
  and `setOpenSession`/`subscribeTranscript`.

## Two structural blockers (verified against source)

### B1 — Client mention regex does not parse the instance suffix

`src/components/mention-renderer.tsx:13` uses
`/@\[([^\]]+)\]\((user|agent):([a-f0-9-]+)\)/g`. A pinned token
`@[Name](agent:uuid?cwd=%2Fhome%2Fx&host=prod)` does NOT match (the `?…` defeats the
trailing `)`), so it renders as broken raw text. The server-side parser
(`mention.service.ts`) already uses an extended regex with an optional 4th group; the
**client** path must match that, then decode the suffix with `decodePinSuffix` from
`src/lib/mention-format.ts` (pure, dependency-free, already exported). No new parsing
logic is invented — we reuse the existing codec.

### B2 — Comment mentions render via imperative DOM injection

`ContentWithMentions` → `MentionPostProcessor` (`mention-renderer.tsx:163`) walks the
rendered markdown's text nodes with a `TreeWalker` and replaces placeholder text with
`document.createElement("span")`. Imperatively-injected DOM cannot host an interactive
React component (`<Popover>` with state, event handlers). Therefore the **comment render
path** must render mentions as real React nodes.

To keep scope to comments only (elaboration answer q6 = "comments only"), we do NOT change
the shared `ContentWithMentions` DOM-injection behavior for other surfaces. Instead the
comment path opts into a React-native mention renderer. Two viable approaches — the task
implementer picks based on what keeps the blast radius smallest:

- **(preferred) A comment-scoped variant**: `unified-comments.tsx`'s `CommentItem`
  renders the body through a markdown renderer whose mention placeholders are replaced by
  React `<MentionBadge>` / text nodes (e.g. a `components`/rehype mapping, or splitting the
  body into markdown segments + React mention nodes), instead of calling the DOM-injecting
  `ContentWithMentions`.
- **(alternative) A render-prop on `ContentWithMentions`**: add an optional
  `renderMention?: (ref) => ReactNode` prop; when provided, render mentions as React nodes
  via a non-DOM-injection path; when absent, behavior is byte-for-byte unchanged. Only the
  comment path passes the prop.

Either way: **agent** mentions in comments become `<MentionBadge>`; **user** mentions keep
the current styled-text appearance (q1 = agent mentions only).

## Architecture

```
unified-comments.tsx (CommentItem)
  └─ comment-scoped mention rendering (React-native, NOT DOM injection)
       ├─ user mention      → existing styled text span (unchanged)
       └─ agent mention     → <MentionBadge ref={MentionRef} />
                                 ├─ resolves liveness from useAgentPresence().connections
                                 │     - pinned:    match (agentUuid, host, cwd) → effectiveStatus
                                 │     - non-pinned: agent online if ANY connection for agentUuid is online
                                 ├─ <Badge> name + online dot   (click → <Popover>)
                                 └─ <PopoverContent>
                                       ├─ identity: name, online status
                                       │     + cwd + host  (pinned only)
                                       └─ owner? && online? → <Button> "Open conversation"
                                              → openChatForAgent(agentUuid, pin?)
```

## Data Model

No schema changes.

`ConnectionView` (`src/components/agent-presence/types.ts`) must expose **`ownerUuid`** so
the client can gate the owner-only button without an extra fetch. If it is not already
present, add it and populate it in the `/api/agent-connections` response (the server
already knows the connection's agent and the agent's owner — see the owner check in
`src/app/api/daemon/control/route.ts`, which compares `target.ownerUuid` to
`auth.actorUuid`). This mirrors the **same** owner rule on the client.

## Liveness resolution (the core matching rule)

Given a parsed `MentionRef` and `connections: ConnectionView[]` from `useAgentPresence()`:

- **Pinned mention** (`pinnedCwd`/`pinnedHost` present — elaboration q2 = precise
  instance level): online iff there exists a connection with
  `agentUuid === ref.uuid && host === ref.pinnedHost && cwd === ref.pinnedCwd &&
  effectiveStatus === "online"`. The popover shows that instance's `cwd`/`host` formatted
  via `formatCwd`/`formatHost` (`src/lib/daemon-instance-format.ts`).
- **Non-pinned mention** (q9 = agent-overall online): online iff ANY connection with
  `agentUuid === ref.uuid` has `effectiveStatus === "online"`. The popover shows name +
  overall online state only — **no** cwd/host (there is no single instance).

Owner gate (q5): the "Open conversation" button renders only when
`currentUserUuid === ownerUuid` for the agent. Resolve `ownerUuid` from the matched
connection's `ownerUuid` (preferred) or, if no connection exists (offline), the button is
moot because it is also online-gated. Resolve `currentUserUuid` via `useAuth().user.uuid`
(`src/contexts/auth-context.tsx`) — already available app-wide; do NOT thread a new prop if
the hook is accessible at the comment render site.

Online gate (q4): when offline, the button is **hidden** (not disabled). Everyone — owner
or not — still sees the badge + popover identity (q5 option a).

## Open-conversation action contract

A new imperative entry point on the presence provider, e.g.
`openChatForAgent(agentUuid: string, pin?: { host: string; cwd: string | null })`:

1. `setModalOpen(true)` to open the presence modal hosting `DaemonChat`.
2. Communicate the target so `DaemonChat` focuses the right instance/session:
   - **pinned**: target the connection matching `(agentUuid, host, cwd)`. The elaboration
     answer q3 = "just open the daemon chat" — so we open the chat focused on that
     instance; precise auto-selection of a specific past session is NOT required.
   - **non-pinned** (q8 = open daemon chat, owner picks inside): open the chat focused on
     the agent; the existing `DaemonChat` left rail / instance picker
     (`src/components/agent-presence/instance-picker.tsx`) lets the owner choose the
     instance/conversation.
3. `DaemonChat` already drives `setOpenSession` when a conversation is selected; we only
   need to seed which agent/instance it focuses. The exact seam (a `focusTarget` field on
   the provider that `DaemonChat` reads on open, vs. a param to `setModalOpen`) is an
   implementation detail for the task; it MUST NOT regress existing modal/`setOpenSession`
   behavior.

> The presence provider sits at the shell, ABOVE per-project `RealtimeProvider`s, and the
> comment area is within its tree — so `useAgentPresence()` is available at the comment
> render site (consistent with the existing presence-pill usage). Confirm during
> implementation that the comment render site is inside `AgentPresenceProvider`.

## Module Contracts

- **Mention parse (client)**: returns, per mention, `{ type: "user"|"agent", uuid,
  displayName, pinnedHost?: string|null, pinnedCwd?: string|null }` — same shape as
  `MentionRef`, produced by reusing `decodePinSuffix`. Non-pinned → both pin fields
  null/absent (byte-compatible with today's behavior for unpinned tokens).
- **`ConnectionView`** gains `ownerUuid: string | null`.
- **`MentionBadge` props**: the parsed `MentionRef` (agent only) + the resolved
  `displayName`. It reads presence + auth via hooks; it does not require liveness to be
  passed in.
- **`openChatForAgent`** on `AgentPresenceValue`: documented above; additive, does not
  change existing `setOpenSession`/`subscribeTranscript`/`setModalOpen` signatures.

## UI / primitives

Reuse existing `src/components/ui/` primitives: `Badge`, `Popover`/`PopoverTrigger`/
`PopoverContent`, `Button`. Online dot can reuse the existing presence dot styling
(e.g. the pattern in `presence-indicator.tsx`). Formatting of `cwd`/`host` reuses
`formatCwd`/`formatHost` (`src/lib/daemon-instance-format.ts`) with their i18n keys.

## i18n

All new strings via `t()` in both `messages/en.json` and `messages/zh.json`:
"Open conversation", online/offline labels, popover field labels (host, working
directory), and any tooltips. Follows the project's CRITICAL i18n rule.

## Implementation Plan

1. **Parser + liveness foundation**: extend client mention parsing to read the pin suffix
   (reuse `decodePinSuffix`); add `ownerUuid` to `ConnectionView` + `/api/agent-connections`;
   add a small `useMentionLiveness(ref)` helper (or inline) implementing the matching rule.
2. **`MentionBadge` component**: badge + online dot + popover identity + owner/online-gated
   "Open conversation" button; wire `openChatForAgent`. Add i18n keys.
3. **Comment render integration**: move the comment body mention rendering to a
   React-native path so agent mentions mount `<MentionBadge>` and user mentions keep
   current text; leave all other `ContentWithMentions` surfaces untouched.

## Risks & Mitigations

- **Regressing other mention surfaces**: keep the DOM-injection `ContentWithMentions`
  default behavior unchanged; comments opt in explicitly. Mitigation: the comment-scoped
  variant / opt-in render-prop, with a test asserting non-comment surfaces are byte-stable.
- **Popover inside scrollable comment list**: use the Radix `Popover` portal (already the
  default in `src/components/ui/popover.tsx`) so clipping/overflow is not an issue.
- **Owner identity drift**: gate strictly on `ownerUuid === currentUserUuid`, mirroring the
  server rule in `daemon/control/route.ts`; never infer ownership from name/email.
- **`ConnectionView.ownerUuid` already present**: verify before adding; if present, the API
  task is a no-op and only the type doc is confirmed.
- **Pinned-but-offline / instance gone**: matching simply yields offline → dot offline,
  button hidden. No special-casing required.

## Verification anchors

- `src/components/mention-renderer.tsx` (B1, B2), `src/lib/mention-format.ts`
  (`decodePinSuffix`), `src/components/unified-comments.tsx` (`CommentItem`),
  `src/contexts/agent-presence-context.tsx` (`connections`, `setOpenSession`,
  `setModalOpen`), `src/components/agent-presence/chat/daemon-chat.tsx`,
  `src/components/agent-presence/instance-picker.tsx`,
  `src/lib/daemon-instance-format.ts`, `src/app/api/daemon/control/route.ts` (owner rule),
  `src/contexts/auth-context.tsx` (`useAuth().user.uuid`).
