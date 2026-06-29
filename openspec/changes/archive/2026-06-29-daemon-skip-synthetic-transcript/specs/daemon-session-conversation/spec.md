## ADDED Requirements

### Requirement: The daemon SHALL exclude harness-injected synthetic content from the transcript it syncs

The Claude Code daemon backend SHALL NOT sync harness-injected synthetic conversation
content (for example, the full body of a loaded skill) to Chorus. The daemon's
stream-json transcript extractor SHALL drop any `type:"user"` stream envelope marked as
synthetic by Claude Code (the `isSynthetic: true` field on the live
`claude -p --output-format stream-json` stdout) before any text is extracted from it, so
that such content is never posted to `POST /api/daemon/transcript`. The exclusion SHALL
be a purely structural match on the synthetic marker — it SHALL NOT use a size threshold
or content/text-pattern heuristic — so that genuine human instructions, the agent's own
replies, tool-result summaries the agent authors, and error messages (none of which
carry the synthetic marker) are never dropped. The behavior SHALL be always on with no
configuration knob. This requirement SHALL apply to the Claude Code backend only; the
codex (`codex exec --json` / `item.completed`) backend extraction SHALL be unchanged.

As defense-in-depth, where a retained `text` block still wraps a
`<system-reminder>…</system-reminder>` span, the daemon SHALL strip that span from the
stored text, and SHALL drop the message entirely if no non-reminder text remains. The
extractor SHALL continue to never throw on an unrecognized shape (returning "not a
keepable message" instead).

#### Scenario: A loaded skill body is not synced

- **GIVEN** a Claude Code daemon session whose stream-json stdout contains a
  `type:"user"` envelope with `isSynthetic: true` carrying a `text` block with a skill
  body (e.g. text beginning "Base directory for this skill: …")
- **WHEN** the daemon's transcript extractor processes that envelope
- **THEN** the extractor MUST yield no message for it
- **AND** no skill-body text MUST be posted to `POST /api/daemon/transcript`

#### Scenario: A human instruction is still synced

- **GIVEN** a `type:"user"` envelope with no synthetic marker carrying a `text` block
  with a human wake instruction (e.g. text beginning "[Chorus] …")
- **WHEN** the daemon's transcript extractor processes that envelope
- **THEN** the extractor MUST yield a `user` message with that instruction text
- **AND** that text MUST be eligible to sync to Chorus

#### Scenario: A genuine agent reply that quotes injected text is not dropped

- **GIVEN** a `type:"assistant"` envelope with no synthetic marker whose `text` block
  happens to contain a phrase that also appears in injected content (e.g. the agent
  discusses "Base directory for this skill" in its own words)
- **WHEN** the daemon's transcript extractor processes that envelope
- **THEN** the extractor MUST yield an `assistant` message with the reply text
  (the structural match on the synthetic marker MUST NOT classify a non-synthetic
  message as injected based on its content)

#### Scenario: A wrapped system-reminder is stripped from retained text

- **GIVEN** a retained, non-synthetic `text` block that contains a
  `<system-reminder>…</system-reminder>` span alongside other text
- **WHEN** the daemon's transcript extractor processes it
- **THEN** the stored text MUST have the system-reminder span removed
- **AND** if removing the span leaves no non-whitespace text, the extractor MUST yield
  no message

#### Scenario: The codex backend extraction is unaffected

- **GIVEN** a codex `item.completed` `agent_message` stream item
- **WHEN** the daemon's transcript extractor processes it
- **THEN** the extractor MUST yield the assistant text exactly as it did before this
  change (the synthetic-content exclusion MUST NOT alter the codex dialect path)
