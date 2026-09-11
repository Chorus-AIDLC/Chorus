# document-markdown-rendering Specification

## Purpose

Defines how Chorus renders user-authored Markdown content across the
application — Documents, Proposals, Ideas, Tasks, and Comments. The
canonical entry point is the `MarkdownContent` component, which is the
sole consumer of Streamdown plugins and controls. This capability covers
mermaid diagram rendering, syntax-highlighted code blocks, theme
behavior, and the centralization rule that keeps every Markdown surface
on the same rendering path.
## Requirements
### Requirement: Mermaid code blocks render as diagrams

The Chorus Markdown rendering pipeline SHALL detect ` ```mermaid ` fenced
code blocks in document, proposal, idea, task, and comment content and
render them as SVG diagrams via the `@streamdown/mermaid` plugin.

Supported diagram kinds MUST include the standard mermaid set:
flowchart, sequenceDiagram, classDiagram, stateDiagram, erDiagram, and
gantt.

When mermaid syntax is invalid, the plugin SHALL fall back to displaying
the raw code block plus an inline error message — never throwing past
the rendering boundary and crashing the surrounding page.

While the markdown stream is still arriving (the closing fence has not
yet appeared), the block SHALL render as a normal code block; the
mermaid render only fires once the fence closes. This preserves
streaming semantics for partial output.

#### Scenario: Valid mermaid block in a Document renders as SVG

- **WHEN** a Document contains a ` ```mermaid ` block with a valid
  `flowchart TD` definition and a user opens the Document detail page
- **THEN** the rendered output contains an `<svg>` element produced by
  mermaid
- **AND** the original ` ``` ` fence content is not visible as raw text
  on the page

#### Scenario: Invalid mermaid block does not crash the page

- **WHEN** a Document contains a ` ```mermaid ` block with malformed
  syntax (e.g. unterminated arrow)
- **THEN** the page renders successfully without a React error boundary
- **AND** an error message from mermaid is shown in place of the
  diagram, with the original code visible for debugging

#### Scenario: Streaming markdown shows code, then diagram

- **WHEN** the markdown stream has emitted ` ```mermaid\nflowchart TD` but
  not the closing fence yet
- **THEN** the partial content renders as a code block, not as an
  attempted diagram
- **AND** once the closing fence arrives, the same block re-renders as
  an SVG diagram

### Requirement: Mermaid blocks expose interactive controls

Each rendered mermaid block SHALL display a toolbar with **fullscreen**,
**download**, **copy**, and **panZoom** controls, all enabled.

#### Scenario: Toolbar controls are clickable

- **WHEN** a user hovers a rendered mermaid block in any Markdown
  surface
- **THEN** the toolbar buttons for fullscreen, download, copy, and
  panZoom are visible and respond to clicks
- **AND** the click does not produce a console error or
  `pointer-events: none` blockage

### Requirement: Mermaid theme follows Chorus light/dark theme

Mermaid diagrams SHALL render in mermaid's `default` palette when
Chorus is in light theme and in mermaid's `dark` palette when Chorus
is in dark theme. The theme MUST update when the user toggles theme
without requiring a page reload.

#### Scenario: Theme toggle re-renders mermaid diagram

- **WHEN** a Document containing a mermaid block is open and the user
  toggles Chorus' theme from light to dark via the theme switcher
- **THEN** the mermaid SVG re-renders with the dark palette
  (background and node fills change to mermaid's dark variant)
- **AND** the user does not need to reload the page

### Requirement: Markdown rendering is centralized via MarkdownContent

All Markdown rendering surfaces in the application SHALL render through
the `MarkdownContent` component (`src/components/markdown-content.tsx`),
which is the single consumer of `streamdownPlugins` and
`streamdownControls` from `src/lib/streamdown-plugins.ts`. No call
site outside `MarkdownContent` SHALL import `streamdown` directly or
construct its own `plugins` / `controls` props.

#### Scenario: New Markdown surface added

- **WHEN** a developer adds a new Markdown surface (e.g. a new sidebar
  panel rendering user content)
- **THEN** they import `MarkdownContent` and use it as
  `<MarkdownContent>{content}</MarkdownContent>`
- **AND** they do NOT import `streamdown` or `@streamdown/mermaid`
  directly

#### Scenario: Existing call sites use MarkdownContent

- **WHEN** a reviewer greps for `Streamdown` import outside
  `markdown-content.tsx`
- **THEN** no `.tsx` file under `src/` contains a top-level
  `import { Streamdown }` statement other than the canonical
  renderer

### Requirement: Leading YAML frontmatter renders as a metadata card

The Chorus Markdown rendering pipeline SHALL detect a YAML frontmatter
block at the very start of Markdown content and render its key/value
pairs as a metadata card placed above the rendered body, instead of
rendering the block as body prose.

A block qualifies as frontmatter only when ALL of the following hold:

1. The content begins exactly with a `---` fence line (no leading blank
   lines or whitespace before it).
2. A closing fence line of exactly `---` or `...` appears later.
3. Every line between the fences is blank, a `#` comment, or a
   `key: value` pair whose key matches `[A-Za-z0-9_.-]+`.
4. At least one `key: value` pair is present.

The frontmatter block MUST be removed from the string passed to the
underlying Markdown renderer, so the body no longer shows the fences as
horizontal rules nor the pairs as paragraphs.

Values MUST be treated as opaque strings — no type coercion, no schema
awareness, and no per-key special casing. A key with an empty value MUST
still be shown, since the presence of the key is itself information.

#### Scenario: Spec-lite change-doc header renders as a card

- **WHEN** a Document opens with a frontmatter block containing `date`,
  `change`, `spec`, `status`, and an empty `proposalUuid`
- **THEN** a metadata card is rendered above the body listing each key
  with its value, including a placeholder for the empty `proposalUuid`
- **AND** no horizontal rule is rendered for either fence
- **AND** no `key: value` line appears as body prose

#### Scenario: Trailing comments are stripped from unquoted values

- **WHEN** a frontmatter line reads `status: in-progress      # proposed | in-progress | done`
- **THEN** the card shows the value `in-progress`
- **AND** the comment text is not shown as part of the value

### Requirement: Non-frontmatter content renders unchanged

Content that does not satisfy every frontmatter recognition rule SHALL
be passed to the underlying Markdown renderer completely unmodified, and
no metadata card SHALL be rendered. A mid-document `---` thematic break
SHALL never be interpreted as a frontmatter fence.

#### Scenario: A comment beginning with a thematic break is untouched

- **WHEN** a comment's content begins with `---` followed by a line of
  prose rather than `key: value` pairs
- **THEN** no metadata card is rendered
- **AND** the content renders exactly as it did before this capability
  existed, with the `---` as a horizontal rule

#### Scenario: Nested YAML is not flattened into a card

- **WHEN** a leading `---` block contains a nested mapping or a YAML list
  rather than only flat `key: value` pairs
- **THEN** no metadata card is rendered
- **AND** the block renders as body content rather than being partially
  interpreted

#### Scenario: A mid-document thematic break stays a rule

- **WHEN** a Document has body text, then a standalone `---` line, then
  more body text
- **THEN** the `---` renders as a horizontal rule
- **AND** no metadata card is rendered for it

### Requirement: Incomplete and body-less frontmatter degrade gracefully

Incomplete (still-streaming) and body-less frontmatter SHALL both render
without error, per the rules below.

While a Markdown stream is still arriving, the closing fence may not have
been received yet. In that state recognition rule 2 does not hold, so the
partial block SHALL render as ordinary body content; once the closing
fence arrives the same content SHALL re-render as a metadata card. The
transition MUST NOT throw or blank the surrounding surface.

When the frontmatter block is the entire content, stripping it leaves an
empty body. The metadata card SHALL still render, and the empty body MUST
be passed to the underlying renderer without error.

#### Scenario: Streaming content snaps to a card when the fence closes

- **WHEN** an agent chat message has streamed `---` and two `key: value`
  lines but not the closing `---`
- **THEN** the partial content renders as body content, not as a card
- **AND** once the closing `---` arrives, the same content re-renders as
  a metadata card without a thrown error or a blanked message

#### Scenario: Content that is only frontmatter renders just the card

- **WHEN** a Document's entire content is a frontmatter block with no body
  after the closing fence
- **THEN** the metadata card is rendered
- **AND** the surface renders without error despite the empty body

### Requirement: The metadata card renders correctly in both themes

The metadata card SHALL be styled exclusively with semantic theme tokens
(such as `border-border`, `bg-muted`, `text-foreground`,
`text-muted-foreground`) and MUST NOT use hardcoded hex colors or
fixed-palette utility classes. It MUST therefore render legibly in both
light and dark theme with no `dark:` variant required.

The card SHALL expose an accessible label sourced from i18n, with the key
present in both the `en` and `zh` message catalogs. Frontmatter keys and
values are user content and MUST NOT be translated.

#### Scenario: Card is legible after a theme toggle

- **WHEN** a Document with a frontmatter card is open and the user
  toggles Chorus from light to dark theme
- **THEN** the card surface, border, key text, and value text all adapt
  to the dark palette and remain legible
- **AND** no reload is required

#### Scenario: i18n label parity

- **WHEN** a reviewer inspects the message catalogs for the card's
  accessible label key
- **THEN** the key exists in every locale catalog under `messages/`
  (`en.json`, `zh.json`, `ja.json`, `ko.json`), as enforced by
  `src/i18n/__tests__/locale-parity.test.ts`

### Requirement: Frontmatter handling applies to every Markdown surface

Because frontmatter detection SHALL be implemented inside the
centralized `MarkdownContent` component, it MUST apply uniformly to
every Markdown surface — Documents, Idea / Proposal / Task detail
panels, dashboard panels, agent chat, and comments — with no
per-call-site changes.

Every prop that `MarkdownContent` currently forwards to the underlying
renderer, including the theme-driven remount key, MUST continue to be
forwarded unchanged.

#### Scenario: A frontmatter block in an Idea description renders as a card

- **WHEN** an Idea's description begins with a valid frontmatter block
  and a user opens the Idea detail panel
- **THEN** the metadata card is rendered above the description body
- **AND** the panel required no code change to obtain this behavior

#### Scenario: Mermaid theme repaint still works

- **WHEN** a Document containing both a frontmatter block and a mermaid
  diagram is open and the user toggles theme
- **THEN** the mermaid diagram repaints with the new palette as before
- **AND** the metadata card is still rendered above the body

