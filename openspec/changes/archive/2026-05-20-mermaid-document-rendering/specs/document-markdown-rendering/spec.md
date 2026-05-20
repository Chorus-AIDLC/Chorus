# Document Markdown Rendering — delta

## ADDED Requirements

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
