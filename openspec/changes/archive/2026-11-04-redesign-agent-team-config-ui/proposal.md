## Why

The Agent Team configuration UI shipped in Agent Team ①–⑤ looks and behaves differently from the rest of Chorus:

- The project dashboard header shows a default-size **项目团队 / Project Team** button next to the compact **Settings** button (`size="sm"`, 12px, `rounded-lg`, muted 14px icon, hover border = primary), so the two header actions do not match.
- The project team editor is a separate 850px `ScrollableDialog` with a 2×2 `bg-muted/20` card grid and an inline handoff section, unlike the 620px `rounded-2xl` tabbed Project Settings dialog.
- Destructive / multi-step interactions are inlined into the DOM: **Unbind** appends a red `role="alert"` box at the bottom of the scroll area instead of opening a confirm dialog, and **Lead handoff** expands an inline preview region.
- Success/error feedback is a plain `<p>` at the bottom of the dialog; each role card stacks Add + Clear role + Reset buttons.
- The `/settings/teams` template page uses yet another layout (4-column muted sections, 2-column fieldset editor).

The owner asked (Idea 6523c6d3, elaboration round 1) for a redesign that unifies style and fixes the awkward interactions, covering both the project team config and the `/settings/teams` template page.

## What Changes

- **Remove** the standalone header `ProjectTeamSettings` button from the project dashboard; add a **Team** tab to the existing Project Settings dialog (next to General / Access). Support the `?settings=team` deep link.
- Rebuild the team editor as a **compact role list**: one row per role (Product / Development / Review / Lead) with role icon + name + inherited/overridden/snapshot `Badge`, member avatar chips (remove ×, online state, ineligible warning), and a trailing **+** add control.
- Move **Clear role** / **Reset to template** into a per-row **…** `DropdownMenu`.
- **Unbind team** opens a shadcn `AlertDialog` confirmation; no inline DOM insertion.
- **Lead handoff** moves out of the main surface into a **Hand off…** button that opens its own dialog: choose lead → preview affected Ideas → confirm.
- Feedback: success via `sonner` toast; errors inline next to the related control.
- Team tab has its own Save button; unsaved team edits prompt a discard confirmation when switching tabs or closing the dialog.
- `/settings/teams`: template list cards and template editor dialog reuse the same shared role-row + member-chip components; button hierarchy, spacing and toasts aligned with Project Settings. Existing delete `AlertDialog` is kept.
- The Team tab keeps today's access model: it is the caller's **personal, owner-private** team, so it is NOT subject to the Project Settings lock (viewers and non-admin members of private projects can still configure it); Idea handoff still requires project Editor access.
- All strings via i18n in all four shipped locales (en, zh, ja, ko — locale parity test), semantic tokens, verified in light and dark themes.
- **Out of scope:** `docs/design.pen` (owner: "暂时不用更新design.pen"); any API / service / schema change; team semantics (eligibility, handoff, freeze) are unchanged.

## Capabilities

### New Capabilities
- `agent-team-config-ui`: presentation and interaction contract for project team configuration (inside Project Settings) and the team template management page.

## Impact

- `src/components/project-team-settings.tsx` → replaced by a Team tab component (e.g. `src/components/agent-team/project-team-tab.tsx`).
- New shared components under `src/components/agent-team/` (role row, member chip, handoff dialog).
- `src/app/(dashboard)/projects/[uuid]/dashboard/project-settings-modal.tsx` (new tab, dirty guard, deep link).
- `src/app/(dashboard)/projects/[uuid]/dashboard/dashboard-content.tsx` (header button removed).
- `src/app/(dashboard)/settings/teams/page.tsx` + its tests.
- `messages/{en,zh,ja,ko}.json` (`projectTeam.*`, `settings.teams.*`).
- No backend, MCP, or database impact.
