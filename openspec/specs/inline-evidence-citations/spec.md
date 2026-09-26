# inline-evidence-citations Specification

## Purpose
TBD - created by archiving change add-inline-evidence-citations. Update Purpose after archive.
## Requirements
### Requirement: Direct evidence UUID Markdown links
The renderer SHALL recognize ordinary Markdown links of the form `[1](ref:<uuid>)`, with a strict hexadecimal 8-4-4-4-12 UUID, and display the author-supplied label as a compact bracketed citation. The UUID SHALL identify an existing evidence record without requiring an owning-resource context. Persisted Markdown MUST remain unchanged. No database, evidence target type, or API data structure changes SHALL be required.

#### Scenario: Evidence in any Markdown surface
- **WHEN** an Idea, Proposal, Task, Document or comment contains a valid ref link
- **THEN** shared Markdown rendering resolves the UUID through the existing authenticated detail API regardless of which resource originally attached the evidence

#### Scenario: Literal and ordinary Markdown
- **WHEN** citation-like text is in code or escaped text, or a regular Markdown link is present
- **THEN** normal Markdown semantics and existing link rendering are preserved
- **AND** malformed ref URLs never become active custom-protocol links

### Requirement: Current evidence details and navigation
Valid citations SHALL expose the current title, type, URL and nonempty notes on hover and keyboard focus. Clicking SHALL directly open the evidence's HTTP(S) URL in a new tab with safe opener behavior. Evidence retrieval MUST use the existing same-origin authenticated UUID endpoint and its tenant checks. The renderer MUST NOT fetch external evidence pages.

#### Scenario: Valid UUID link
- **WHEN** a reader focuses or hovers a valid citation
- **THEN** current details become available and an activated citation opens its external URL directly
- **AND** non-HTTP(S) evidence URLs never become executable hrefs

### Requirement: Missing evidence and transient failures
Deleted or nonexistent evidence SHALL preserve the gray citation marker, reveal the localized equivalent of “证据不存在”, and disable navigation. Loading and request failure SHALL have distinct accessible messages and MUST NOT falsely report absence. The renderer SHALL revalidate on later interaction to reflect updated evidence or recover from errors.

#### Scenario: Updated and deleted reference
- **WHEN** a reference changes and a subsequent hover/focus lookup succeeds
- **THEN** its latest metadata and link are used
- **AND** after deletion a 404 lookup retains the marker with missing text and no href

#### Scenario: Request failure
- **WHEN** the endpoint fails or a request is still loading
- **THEN** the marker shows a distinct non-navigable loading/error state
- **AND** subsequent interaction can retry

### Requirement: Shared renderer and accessible display
The implementation SHALL apply in MarkdownContent without per-resource data plumbing and SHALL preserve existing mention custom tags, frontmatter, Mermaid, code and ordinary links. Repeated UUIDs within one Markdown tree SHALL share in-flight requests; old responses MUST NOT replace a changed citation. Citation colors and detail layout SHALL work in both themes and with long content, keyboard focus and all supported locale catalogs.

#### Scenario: Repeated citation and mixed content
- **WHEN** a content block mixes repeated UUID references with existing Markdown features
- **THEN** repeated references share lookup work and all existing features render correctly

#### Scenario: Accessible missing marker
- **WHEN** a keyboard user focuses a missing marker in either theme
- **THEN** a readable, localized missing message is exposed without requiring color perception or mouse hover

### Requirement: Agent reference instructions
Agent skills SHALL explain UUID linking alongside existing evidence guidance across all seven skill distribution surfaces, preserving each port's tool naming. Documentation SHALL distinguish reference UUIDs from resource UUIDs, explain how to obtain them from existing reference operations, and show use in resource bodies and comments.

#### Scenario: Agent authors a citation
- **WHEN** an Agent follows the reference instructions
- **THEN** it obtains the existing evidence UUID and writes `[1](ref:UUID)` in Markdown without inventing identifiers or changing evidence storage
