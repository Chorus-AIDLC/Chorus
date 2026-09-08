---
slug: <kebab-case-slug>
title: <one-line change title>
status: draft            # draft | active | done
created: <YYYY-MM-DD>
ideaUuid:                # optional — Chorus idea uuid
proposalUuid:            # REQUIRED before the first Chorus mirror — the originating proposal
documentUuid:            # optional — backfill after approval; makes re-mirror deterministic
---

## Intent
<1-2 sentences: the user/business intent this change serves.>

## Requirements
### R1: <requirement name>
<plain prose — no SHALL/MUST grammar required.>
- [ ] AC: <testable acceptance criterion>
- [ ] AC: <testable acceptance criterion>

<!-- Add R2, R3, … as needed. A `## Design` section MAY be added inline when warranted. -->

## Tasks
- [ ] T1: <unit of work>
- [ ] T2: <unit of work> (depends: T1)

## Changelog
- <YYYY-MM-DDThh:mm:ssZ> — created (spec-lite)
