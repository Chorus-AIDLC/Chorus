# document-markdown-rendering — delta

## ADDED Requirements

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
