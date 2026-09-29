# Research action availability verification

- Idea: `940b328e-1d43-4a43-8a41-21be5f1212f5`
- Proposal: `26509a17-eb29-444f-81fe-5719b400b2f7`
- Task: `8ad6203a-fc72-4492-9a46-aa4cd237c883`
- Branch: `fix/research-action-availability`
- Base: `81172effdaa1bf7f5645d02249f2ab458c691784`

## Implemented behavior

The human selected `research_only` and `require_assignment`. Research now
requires an owning agent and a same-agent effectively online presence connection.
It exposes localized assignment/offline reasons through the existing desktop
menu and mobile sheet, and uses that same disabled reason in its selection
handler. The unassigned Research agent chooser is no longer reachable from this
action. Assigned-agent cwd selection still uses captureSelection and atomic
Research dispatch. Server authorization, eligibility, origin/cwd checks and the
other stage actions are unchanged.

## Automated verification

Completed 2026-09-28:

| Suite | Passing tests |
| --- | ---: |
| ResearchAction | 43 |
| IdeaActionsMenu | 43 |
| Research server actions | 10 |
| Research eligibility service | 25 |
| usePinThenWake | 19 |
| YoloButton | 11 |
| Total | 151 |

Command:

```sh
pnpm test src/components/__tests__/research-action.test.tsx \
  'src/app/(dashboard)/projects/[uuid]/dashboard/__tests__/idea-actions-menu.test.tsx' \
  'src/app/(dashboard)/projects/[uuid]/ideas/[ideaUuid]/__tests__/research-actions.test.ts' \
  src/services/__tests__/research-eligibility.service.test.ts \
  src/hooks/__tests__/use-pin-then-wake.test.tsx \
  src/components/__tests__/yolo-button.test.tsx
```

Also passed:

- Scoped ESLint with `--no-ignore` for the modified component and both test files.
- `pnpm exec tsc --noEmit --incremental false`.
- `git diff --check`.
- Impeccable mechanical detector on ResearchAction: no findings.

Coverage includes missing/human assignment, missing presence provider,
offline/stale/unrelated connections, owning-agent resolution for instances,
mounted assignment and presence changes, reconnection while stage-blocked,
pointer/Enter/Space guards, bilingual reasons, duplicate submissions, accepted
repeat requests, server rejection, and ordinary/temporary cwd selection retries.
The full repository suite and production build were not run.

## Browser verification

An isolated local PGlite database and Next.js webpack dev server were used at
`http://localhost:8637`. The standard `dev:local` startup first hit Turbopack's
restriction on the worktree's external node_modules symlink; webpack then
started successfully. Login used local default auth, and fixture records were
created through the local authenticated APIs.

Fixtures:

- Project: `0f94ecca-a499-4bcc-a739-3eb7aa28e8cf`.
- Unassigned Idea: `51c8179f-5d3d-4a9e-978a-0634129ca6b5`.
- Offline-assigned Idea: `764b773b-0b27-4670-b152-d509a6df69b2`.

All 16 combinations passed: en/zh × desktop/mobile × light/dark ×
offline/unassigned. Desktop viewport was 1440×1000; mobile was 390×844.
Each case checked `aria-disabled`, the localized accessible description,
pointer/Enter/Space suppression and continued menu visibility. Desktop tooltips
were opened through focus and inspected; mobile reasons remained visible inline.
The final screenshots were visually inspected in both themes, with no clipping
of the Research explanation and clear focus styling.

The browser harness waits for the panel's content and finite entry animations
before interacting. Earlier harness attempts incorrectly set only the locale
cookie (the client initializes from localStorage) or captured/moused over a
moving sheet; those attempts were corrected and the final matrix rerun.

Local, gitignored evidence:

- `.playwright-mcp/research-{en,zh}-{desktop,mobile}-{light,dark}-{offline,unassigned}.png`
- `.playwright-mcp/research-desktop-contact-sheet.png`
- `.playwright-mcp/research-mobile-contact-sheet.png`
- `.playwright-mcp/verify-research-en.js` and `verify-research-zh.js`

This verifies the local application with real authenticated fixture records;
it does not claim production deployment or execution by a live daemon.
Live presence transitions and successful dispatch/error paths are covered by
the focused automated tests.

## Design waiver and review status

`CLAUDE.md:215` requires updating `docs/design.pen` for every user-facing change
through Pencil. This obligation was added to the proposal after the independent
Round 1 review; Round 2 passed. On 2026-09-29, the human explicitly waived it for
this delivery: “不用管pencil，推进到完成” (Idea comment
`c24d81e7-78ed-4bec-960e-e517bea482f1`, author
`aa0b0ed8-23c9-4046-9bf5-b0b99bcbde88`).

Pencil `get_app_state` failed with “Failed to access file undefined. A file needs
to be open in the editor to perform this action.” An explicit-file
`execute` against `/home/ubuntu/dev/ai-pm-research-action/docs/design.pen` failed
with the same no-open-document condition. No encrypted file was read or modified
through filesystem tools.

The waiver settles the design-file portion of AC7; its browser/theme checks
passed as recorded above. Formal task review, admin verification, aggregate code
review, OpenSpec archive and the Idea completion report are the remaining steps.
No branch was pushed or merged.
