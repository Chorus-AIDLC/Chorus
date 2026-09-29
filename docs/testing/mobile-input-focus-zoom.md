# Mobile input focus zoom — implementation evidence

Idea: `b2343e9a-802b-41fb-85a7-1080399aa4f5`  
Proposal: `f3e4c48f-1513-4e6a-8541-707468dee59f`  
Task: `38ff25cf-1990-4e76-a2b5-a0a92555e5bc`

## Implementation

The `mobile-input-text` class marks actual editable controls. The shared CSS
rule applies below 768 CSS px and on coarse-primary-pointer, no-hover devices,
including landscape phones above the desktop breakpoint. The font declaration
is scoped and important so consumer `text-sm`, arbitrary small font utilities,
and the Tiptap text descendants do not bypass the floor.

The default floor is `max(16px, 1rem)`. A deliberately larger input uses
`--mobile-input-font-size` to retain its larger size. The source inventory found
no production editable control with intentional typography above 16px; a 24px
variant is included in the browser fixture. Wider fine-pointer desktop
typography retains its existing values.

Input, Textarea, CommandInput, and MentionEditor apply the marker centrally.
The two direct native textarea consumers and the native directory-root select
also apply it. The native select was discovered during implementation and uses
the same policy; its change handler and native picker remain intact.

No viewport, gesture, focus, IME, submission, data model, or editor content
serialization code is changed.

## Verification recorded on 2026-09-29

- TypeScript: `pnpm exec tsc --noEmit` passed.
- ESLint: all seven changed TSX files passed.
- Existing tests: 9 files / 85 tests passed, covering IME, global search,
  MentionEditor popup/selection/reply, mention picker confirmation, directory
  browser, conversational entry, and instruction input. Existing RadioGroup
  controlled/uncontrolled warnings appeared in conversational-entry tests.
- `git diff --check` passed.
- Impeccable detector: one warning on the pre-existing dynamically created
  mention avatar `<img>`; the changed code does not touch it.
- Chromium and desktop WebKit CSS fixtures: 12 cases per engine passed (six
  viewport/input configurations, each in light and dark themes). Actual Input, Textarea, and CommandInput
  components were rendered with React's server renderer. Native controls and
  a contenteditable descendant fixture exercise the CSS rule separately.
  These isolated fixtures are supplementary to the mounted checks below.
- Mounted components in the temporary Next.js preview: 12 Chromium and 12
  desktop WebKit cases passed, covering the same six viewport/input settings
  and both themes. Checked real Tiptap paragraphs and mention nodes, shared
  inputs, CommandInput, global search, group-name/description dialog and
  document editing. Verified IME does not submit, ordinary Enter submits,
  Shift+Enter retains newlines, mention insertion retains the marker, and no
  page-level horizontal overflow appears. Document/group edits were cancelled,
  never saved.
- Browser paste handling: dispatched a text/plain ClipboardEvent into the real
  Tiptap editor in both Chromium and desktop WebKit; the saved editor state
  retained `粘贴中文\nPasted English`.
- Actual application routes: `/login` returned 200 with 16px email/password
  controls and local default login succeeded. `/projects` loaded authenticated;
  its New Project dialog passed four 390/844px × light/dark input checks.
  Screenshots were inspected with CSS transitions completed; the form was
  cancelled without creating a project.
- Independent read-only code preflight found no code blockers, missed editable
  surfaces, important font conflicts, or concrete cmdk glyph clipping. This
  preflight is not the formal Chorus task acceptance or ship-time gateway.

| Width / input | Input / Textarea / Command / native textarea | Contenteditable descendant with 12px override | Larger variant | Native select | Read-only text |
| --- | --- | --- | --- | --- | --- |
| 390px / touch | 16px | 16px | 24px | 16px | 14px |
| 844px / touch | 16px | 16px | 24px | 16px | 14px |
| 767px / fine pointer | 16px | 16px | 24px | 16px | 14px |
| 768px / touch | 16px | 16px | 24px | 16px | 14px |
| 768px / fine pointer | 14px | 12px | 24px | 12px | 14px |
| 1280px / fine pointer | 14px | 12px | 24px | 12px | 14px |

The excluded checkbox remained at its original 12px font in every case.
Chinese/English text and multiline native input values were retained.
The final isolated fixtures use freshly compiled application CSS. The initial
full-workspace compilation was blocked while scanning generated CDK asset
directories, so compilation restricted automatic Tailwind scanning to `src`.
The same build-only restriction is used in an isolated source copy at
`/tmp/chorus-mobile-preview-t31adxyn`, served on port 8638. The production
workspace's Tailwind source configuration is unchanged. The temporary
`/mobile-input-check` route imports the actual application components; it is
not added to the product. All eight modified source files match the preview
copy byte-for-byte except that source-scanning import on the copied CSS file.

Local diagnostic artifacts are under the gitignored `.playwright-mcp/`
directory: `mobile-input-style-results.txt`, `mobile-input-webkit-results.txt`,
`mobile-input-mounted-chromium.txt`, `mobile-input-mounted-webkit.txt`, and
`mobile-input-project-form.txt`, plus `mobile-input-paste-{chromium,webkit}.txt`.
Representative inspected screenshots are
`mobile-input-project-390-light.png` and `mobile-input-project-844-dark.png`.

## Deployment verification on 2026-09-29

The requester authorized deployment and a PR to `develop`, with pen synchronization
waived. A separate worktree based on `origin/develop` (`d0922bb7`) contains only
this feature; unrelated Pi daemon commits on the original detached HEAD are
excluded. TypeScript, changed-file ESLint, all 85 related tests, and OpenSpec
strict validation passed again in this worktree.

The existing `default_deploy.sh` flow built and deployed the production Docker
image to https://chorus-dev.chorus-ai.dev. Its script copy only changes
`SCRIPT_DIR` to the isolated worktree and stays outside the Docker build context.
The eight modified source files match the CDK image asset byte-for-byte:
`092908cfe389f9052363e4e9e193593ddc24b44f00588c2d0c8ba9b463b9bc0c`.
The published image digest is
`sha256:2b3b73c2e0e83f5d07c4b76f81f9cd48efbdb48196918f5c3fad15ffc28fbedc`.
ECS task definition revision 380 reached `COMPLETED` with two running instances
and zero pending instances.

- `/api/health`: HTTP 200, `status: ok`, `database: connected`.
- Deployed `/login` and `/login/admin`: 12 desktop Chromium checks passed across
  390/844px touch emulation and 1280px fine-pointer desktop, each in light/dark.
  Touch inputs compute to 16px before/after focus; desktop inputs retain 14px.
  The real deployed input marker is present, no horizontal overflow appears,
  and the viewport remains `width=device-width, initial-scale=1`.
- The deployed 390px login screenshot was inspected without clipping issues.
- No login form was submitted and no application records were created by this
  deployment smoke check. These are desktop checks, not physical-device proof.

## Human acceptance on 2026-09-29

At 16:21 UTC the requester confirmed “我验证通过了，继续chorus的流程，
@Admin Claude review一下，没问题就merge吧” in Chorus idea comment
`df01ec16-4ae5-43ac-9e58-98dc475423bd`. This is the human acceptance evidence
for proceeding past the previously pending mobile verification gate. Admin
Claude is the designated independent reviewer; merge is authorized only after
review passes.

The requester did not provide device models, OS/browser versions, route-level
results, or separate Android/Safari results. We record the overall acceptance
as stated, without inventing these details or claiming that the agent performed
physical-device tests. Desktop browser checks remain supplementary evidence.
The source inventory covers all production inputs; representative mounted and
application routes were exercised, rather than every route manually.

`docs/design.pen` synchronization was explicitly waived by the requester at
14:01 UTC (comment `63b406f3-8eef-4bb4-a286-557144027621`). No pen file was
modified. Task/admin verification and the aggregate code review still precede
OpenSpec archival and the final Idea completion report.

## Source audit method and exclusions

The inventory below comes from a TypeScript AST traversal of production TSX
files, followed by searches for `contentEditable`, `editorProps`, and dynamic
`document.createElement` calls and inspection of the matching source. It checks
real JSX opening elements rather than a regex truncated by event-handler `>`.

- Shared component imports cover login, admin login, onboarding AgentFormFields,
  company administration, project/group management, search/graph search,
  Idea/task/proposal forms, elaboration, reference forms, and daemon
  conversation/instruction inputs.
- Tiptap uses an `EditorContent`-mounted editable root whose class is set through
  `editorProps.attributes`; its plain paragraph/inline descendants share the
  scoped rule. `unified-comments` consumes this editor.
- The direct file upload input and two project-group radio inputs are excluded.
  Shared Input also excludes checkbox/radio/range/file/hidden/button/submit/
  reset/color/image types from the CSS selector.
- `src/app/admin/companies/page.tsx` creates a temporary off-screen textarea for
  clipboard fallback. It is not a user editing entry point and is unchanged.
- Radix Select button triggers, checkboxes, radios, read-only markdown,
  placeholder skeletons, and mention suggestion menus are not text editing
  roots. Existing disabled/readOnly semantics are unchanged.

## Production JSX inventory

Each listed shared component inherits the central marker. Native controls are
marked directly or explicitly excluded above. The dynamic Tiptap root is
covered separately in the audit method.

| Source | Controls |
| --- | --- |
| `src/app/(dashboard)/projects/[uuid]/dashboard/new-idea-dialog.tsx` | Input × 1, Textarea × 1 |
| `src/app/(dashboard)/projects/[uuid]/dashboard/panels/idea-detail-panel.tsx` | Input × 1, Textarea × 1 |
| `src/app/(dashboard)/projects/[uuid]/dashboard/panels/move-idea-dialog.tsx` | CommandInput × 1 |
| `src/app/(dashboard)/projects/[uuid]/dashboard/panels/set-parent-dialog.tsx` | CommandInput × 1 |
| `src/app/(dashboard)/projects/[uuid]/dashboard/project-settings-modal.tsx` | Input × 1, Textarea × 1 |
| `src/app/(dashboard)/projects/[uuid]/documents/[documentUuid]/document-content.tsx` | textarea × 1 |
| `src/app/(dashboard)/projects/[uuid]/documents/create-document-dialog.tsx` | Input × 1, input × 1 |
| `src/app/(dashboard)/projects/[uuid]/graph/resource-graph.tsx` | Input × 1 |
| `src/app/(dashboard)/projects/[uuid]/ideas/idea-detail-panel.tsx` | Input × 2, Textarea × 1 |
| `src/app/(dashboard)/projects/[uuid]/proposals/[proposalUuid]/proposal-actions.tsx` | Textarea × 4 |
| `src/app/(dashboard)/projects/[uuid]/proposals/[proposalUuid]/proposal-editor.tsx` | Input × 1, Textarea × 1 |
| `src/app/(dashboard)/projects/[uuid]/proposals/[proposalUuid]/task-draft-detail-panel.tsx` | Input × 2, Textarea × 1 |
| `src/app/(dashboard)/projects/[uuid]/proposals/new/create-proposal-form.tsx` | Input × 1, Textarea × 1 |
| `src/app/(dashboard)/projects/[uuid]/tasks/task-detail-panel.tsx` | Input × 2, Textarea × 1 |
| `src/app/admin/companies/[uuid]/page.tsx` | Input × 4 |
| `src/app/admin/companies/new/page.tsx` | Input × 4 |
| `src/app/login/admin/page.tsx` | Input × 2 |
| `src/app/login/page.tsx` | Input × 3 |
| `src/components/AgentFormFields.tsx` | Input × 1, Textarea × 1 |
| `src/components/acceptance-criteria-editor.tsx` | Input × 1 |
| `src/components/agent-presence/conversational-entry.tsx` | Textarea × 1 |
| `src/components/agent-presence/directory-browser.tsx` | select × 1, Input × 1 |
| `src/components/agent-presence/send-instruction-box.tsx` | Textarea × 1 |
| `src/components/create-project-dialog.tsx` | Input × 1, Textarea × 1 |
| `src/components/create-project-group-dialog.tsx` | Input × 1, Textarea × 1 |
| `src/components/elaboration-panel.tsx` | Input × 1 |
| `src/components/global-search.tsx` | Input × 1 |
| `src/components/manage-project-group-dialog.tsx` | Input × 1, textarea × 1, input × 2 |
| `src/components/proposal-filter.tsx` | CommandInput × 1 |
| `src/components/references-section.tsx` | Input × 2, Textarea × 1 |
| `src/components/ui/input.tsx` | input × 1 |
| `src/components/ui/textarea.tsx` | textarea × 1 |
| `src/components/unified-comments.tsx` | MentionEditor × 1 |
