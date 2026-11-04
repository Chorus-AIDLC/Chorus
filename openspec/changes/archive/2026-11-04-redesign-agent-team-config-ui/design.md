## Context

Current files:
- `src/components/project-team-settings.tsx` — `ProjectTeamSettings` (header button) + `ProjectTeamEditor` (850px `ScrollableDialog`; state: `team`, `templates`, `agents`, `templateUuid`, `overrides`, `dirty`, `preview`, `unbind`; API: `GET/PUT/DELETE /api/projects/:uuid/team`, `POST /api/projects/:uuid/team/handoff`, `GET /api/agent-teams`, `GET /api/agent-teams/candidates`).
- `src/app/(dashboard)/projects/[uuid]/dashboard/project-settings-modal.tsx` — 620px `Dialog`, `rounded-2xl border-0 p-0`, header `px-7 py-6`, `Tabs` (general, access), deep link `?settings=agent-cwds`, danger zone with `AlertDialog`.
- `src/app/(dashboard)/settings/teams/page.tsx` — template list (`Card` per template, 4 role sections) + `TeamEditor` (`ScrollableDialog` 3xl, 2-col role fieldsets) + delete `AlertDialog`.

All existing behavior (eligibility via `getAgentTeamRoleEligibility`, override semantics, frozen snapshots, handoff preview token, `useCanEditProject`, error code → message mapping) is preserved; only presentation and interaction change.

## Goals / Non-Goals

**Goals:** one header Settings entry; Team tab visually identical in chrome to General/Access; compact, scannable role rows; every destructive or multi-step action in a proper dialog; shared role/member components reused by `/settings/teams`; light + dark correct.

**Non-Goals:** API/schema/service changes; changing team semantics; `docs/design.pen` update (explicitly deferred by owner).

## Decisions

### D1. Team as a Project Settings tab
Add `<TabsTrigger value="team">` to `ProjectSettingsModal`. Tabs become controlled (`value` state) so the dirty guard can intercept switches. `?settings=team` opens the dialog on the Team tab (alongside the existing `agent-cwds` deep link). The Team tab content is a self-contained `ProjectTeamTab` component (logic lifted from `ProjectTeamEditor`), lazy-loading its data when the tab is first shown. It reports `dirty` and `busy` to the modal via callback props.
`dashboard-content.tsx` drops `<ProjectTeamSettings>`; the header keeps only the Settings button. The old `project-team-settings.tsx` export is deleted (no other consumers besides tests).

**Access model (unchanged, must be preserved):** the project team is the caller's personal, owner-private configuration ("My project team"), not a project setting. The Team tab therefore MUST NOT inherit `settingsLocked` / `lockedByAccess` from `ProjectSettingsModal` (which disables controls for non-admins of private projects and while access is loading). Team edit controls follow the existing `ProjectTeamEditor` rules: any project member who can open the project can edit and save their own overrides; template-candidate eligibility still uses `useCanEditProject` exactly as today; the Hand off… action is shown disabled with the existing `projectTeam.viewer` explanation when the caller lacks project Editor access. The Team tab is visible to everyone who can see the Settings button.

**Tests:** project-team tests move to a dedicated file (e.g. `src/components/agent-team/__tests__/project-team-tab.test.tsx`); `src/app/(dashboard)/settings/teams/__tests__/page.test.tsx` keeps only template-page tests, so the two implementation tasks do not edit the same test file.

### D2. Shared components (`src/components/agent-team/`)
- `TeamRoleRow` — props: `role`, `members: MemberChipData[]`, `badge?: ReactNode`, `addOptions` (AgentSelect options), `onAdd`, `onRemove`, `actions?: ReactNode` (rendered inside a `…` `DropdownMenu`), `disabled`, `readOnly`. Layout: a single bordered list (`divide-y divide-border rounded-xl border border-border bg-card`), each row `flex items-start gap-3 px-4 py-3`: left column (role icon in `bg-primary/10 text-primary` square + name + badge + one-line muted description), middle wrap of chips, right `+` popover add (wraps existing `AgentSelect`) and `…` menu.
- `TeamMemberChip` — avatar 20px, name, optional presence dot (`PresenceIndicator` or token-colored dot), ineligible state (`border-destructive/40` + `AlertTriangle`, reason in a `Tooltip` and `aria-describedby`), remove × (`Button size="icon" variant="ghost"`), `readOnly` hides ×.
- Role icons map moved from `settings/teams/page.tsx` into the shared module.

### D3. Status badge
`Badge variant="secondary"` (inherited), `variant="outline"` with primary text (overridden), muted outline (snapshot). Text from existing `projectTeam.inherited|overridden|snapshot` keys.

### D4. Dialogs instead of inline DOM
- **Unbind:** `AlertDialog` triggered from a "Unbind team" ghost-destructive button in the Team tab footer area; confirm action runs `DELETE`, toasts `projectTeam.unbound`. Remove the `unbind` inline section.
- **Handoff:** `TeamHandoffDialog` (`Dialog`), opened from a "Hand off…" outline button in the Team tab, disabled while dirty (tooltip/description `projectTeam.saveFirst`). Inside: lead `AgentSelect` → "Preview" → list of affected Ideas with expiry → "Confirm handoff". Closing discards the preview. Success → toast `projectTeam.handedOff` and close.
- **Discard guard:** when the Team tab is dirty and the user switches tab or closes the settings dialog, show an `AlertDialog` ("Discard unsaved team changes?") — confirm discards, cancel stays.

### D5. Feedback
`toast.success` (sonner) for saved / unbound / handed off (team tab) and saved / deleted (templates page). Errors stay inline: save errors near the Save button, handoff errors inside the handoff dialog, unbind errors inside the AlertDialog. Load failures keep the inline retry block.

### D6. Templates page alignment
- List: each template `Card` renders its four roles with read-only `TeamRoleRow`s (compact list) instead of the 4-col muted grid; Edit = `Button variant="outline" size="sm"`, Delete moved to a `…` `DropdownMenu` (destructive item) that opens the existing delete `AlertDialog`. Create button `size="sm"`.
- Editor: role assignments rendered with editable `TeamRoleRow`s (single column list) instead of 2-col fieldsets; permission-detail `<details>` becomes a tooltip/info line on the row. Validation errors stay inline at the top and on the affected member chip.
- Page header/body spacing matches settings pages; `notice` paragraph replaced by toast.

### D7. Styling rules
i18n keys added to all four locales (en, zh, ja, ko). Semantic tokens only (`bg-card`, `border-border`, `text-muted-foreground`, `bg-primary/10`); new amber/destructive tints carry `dark:` variants. Header trigger unchanged. Compact rows must fit the 620px dialog (chips wrap; add/menu controls stay right-aligned; under `sm` the row stacks).

## Risks / Trade-offs

- Folding the team editor into the Project Settings dialog makes the dialog heavier; mitigated by lazy loading on first Team tab activation.
- Controlled tabs + dirty guard adds state to `ProjectSettingsModal`; keep the guard logic in a small hook to limit churn.
- Existing tests referencing `ProjectTeamSettings` / inline unbind / bottom notice text must be rewritten.

## Migration Plan

Pure frontend; ship in one release. No data migration. Rollback = revert.
