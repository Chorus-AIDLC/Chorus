---
title: "PRD: <one-line title for THIS change>"
spec: ../spec.md         # the durable local spec this change advances (local only, never synced)
proposalUuid:            # the Chorus proposal for this change effort (fill once known)
documentUuid:            # persistent Chorus Document (fill after approval; reused on later edits)
---

# <title>

<!-- Per-change PRD. This file lives in <slug>/<YYYY-MM-DD>-<change-slug>/ and IS mirrored 1:1 into a
     persistent Chorus Document of type `prd` (type is implied by the filename). Rename the parent
     folder to <today>-<change-slug>. The durable cumulative spec is ../spec.md (local only) — update
     it in place as part of this change. Prefer prd.md as the primary per-change doc. -->

## Intent
<What this change delivers and why — the intent + background for THIS effort.>

## Requirements
<Plain prose — what must be true when this change lands. No SHALL/scenario grammar.
Acceptance is the `- [ ]` list below.>

- [ ] <testable acceptance point for this change>
- [ ] <testable acceptance point for this change>

## Non-goals
- <what this change deliberately does NOT do>
