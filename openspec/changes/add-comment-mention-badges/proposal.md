# Comment mention badges: online-status agent badges with click-to-popover and owner-only open-conversation

## Why

Today, an `@mention` of an agent in the comment area renders as a static, styled text
span (`src/components/mention-renderer.tsx` → `ContentWithMentions`). It carries no live
signal: a reader cannot tell whether the agent is online, which working directory it is
pinned to, or jump from the comment straight into its conversation.

The underlying data already exists. Mention tokens support an optional instance suffix
`@[Name](agent:uuid?cwd=…&host=…)` (`src/services/mention.service.ts` `MENTION_REGEX`
/ `MentionRef`, codec in `src/lib/mention-format.ts`). Presence is already plumbed:
`AgentPresenceProvider` (`src/contexts/agent-presence-context.tsx`) polls
`/api/agent-connections` and exposes `connections: ConnectionView[]` (each with
`effectiveStatus`, `host`, `cwd`), plus `setOpenSession` and a daemon chat UI
(`src/components/agent-presence/chat/daemon-chat.tsx`).

So this change is fundamentally a **rendering upgrade**: turn the dead mention text in
comments into a live control that reflects online status and, for the agent's owner,
opens the conversation in one click.

Two concrete blockers in the current code must be cleared (both verified against source):

1. **The client mention regex cannot parse the instance suffix.** `mention-renderer.tsx`
   uses `/@\[([^\]]+)\]\((user|agent):([a-f0-9-]+)\)/g`, which fails to match a pinned
   token (`?cwd=…` breaks the trailing `)`), so pinned mentions render as broken raw
   text today. The pin codec (`decodePinSuffix` in `src/lib/mention-format.ts`) already
   exists and is reused.
2. **Comment mentions are rendered by imperative DOM injection.** `MentionPostProcessor`
   walks text nodes and inserts plain `document.createElement("span")` elements — that
   cannot host an interactive React `<Popover>`. The comment render path must move to
   React-native mention rendering.

## What Changes

- **Badge all agent mentions in the comment area** (user mentions are unchanged). A
  mention pinned to a `(host, cwd)` shows an **instance-precise** online dot; a non-pinned
  agent mention shows the agent's **overall** online dot.
- **Click a badge → popover.** The popover shows a minimal identity set: agent name +
  online status, plus `cwd` + `host` for a pinned mention (omitted for non-pinned, which
  has no single instance).
- **Owner-only, online-only "Open conversation" button** inside the popover. It is visible
  ONLY to the agent's owner (`agent.ownerUuid === current user`) and ONLY when the relevant
  instance/agent is online (hidden otherwise — no disabled state). Clicking it opens the
  existing daemon chat: for a pinned mention, focused on that instance; for a non-pinned
  mention, focused on the agent so the owner picks the instance/session inside.
- **Scope is the comment area only.** Only the comment render path
  (`unified-comments.tsx` → its mention rendering) changes; other `ContentWithMentions`
  surfaces (idea / proposal / task descriptions) are untouched.
- **Supporting data plumbing:** extend the client mention parser to read the instance
  suffix (reusing `decodePinSuffix`), and ensure the presence connection data carries the
  agent's `ownerUuid` so the client can gate the owner-only button.

## Capabilities

- **comment-mention-badge** — adds normative requirements that agent mentions in the
  comment area render as online-aware badges, that clicking a badge opens an identity
  popover, and that an owner-only / online-only "Open conversation" action opens the
  daemon chat targeted at the mentioned agent (or pinned instance).

## Impact

- Affected code (all frontend except one small API enrichment):
  - `src/components/mention-renderer.tsx` — client parser learns the pin suffix.
  - `src/components/unified-comments.tsx` — comment render path moves to React-native
    mention rendering and mounts the new badge for agent mentions.
  - New `MentionBadge` component (popover + owner/online-gated button) under
    `src/components/agent-presence/` (or alongside the mention renderer).
  - `src/contexts/agent-presence-context.tsx` + `src/components/agent-presence/chat/daemon-chat.tsx`
    — a mechanism to open the chat modal targeted at a given agent / pinned instance.
  - `/api/agent-connections` + `ConnectionView` type — include `ownerUuid` (only when not
    already present).
- i18n: every new user-facing string (popover labels, button, tooltips, statuses) added to
  both `messages/en.json` and `messages/zh.json`.
- No database schema change. No new dependency. Out of scope: badge-ifying mentions
  outside comments; auto-creating ad-hoc sessions or resolving a "most recent session"
  precisely (the button simply opens the daemon chat); user-mention badges.
