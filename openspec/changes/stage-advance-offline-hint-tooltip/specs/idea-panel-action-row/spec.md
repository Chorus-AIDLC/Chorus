## ADDED Requirements

### Requirement: Offline hint on stage-advance buttons is a tooltip

The Start Development and Yolo stage-advance buttons SHALL present their
agent-offline explanation as an on-demand tooltip rather than as persistent
inline text next to the button. When the assigned agent is offline the button
SHALL remain visible but disabled, and its offline explanation SHALL surface only
on hover or keyboard focus. Because a disabled button emits no pointer events, the
disabled button SHALL be wrapped in a focusable element (`tabIndex = 0`) that owns
the tooltip trigger so the explanation is reachable by both pointer and keyboard
users. The offline explanation copy SHALL be a short, tooltip-sized phrase,
localized in every registered locale (`en`, `zh`, `ko`, `ja`).

The scope of this requirement is the offline hint only. The "started" hint
(shown after a successful click) and any other inline text next to the buttons
SHALL be left unchanged. This behavior applies wherever the shared Start
Development and Yolo buttons are rendered (both the `/ideas` route panel and the
dashboard idea-tracker panel), and it does not change the buttons' gating
predicates, offline policy, or the click-time server-rejection error message.

#### Scenario: Offline hint is not rendered as persistent inline text

- **WHEN** an idea-detail panel shows the Start Development or Yolo button and the assigned agent is offline
- **THEN** the button is visible but disabled
- **AND** no persistent inline hint text is rendered beside the button
- **AND** the offline explanation is available through a tooltip on the button

#### Scenario: Tooltip is reachable on a disabled button via a focusable wrapper

- **WHEN** the offline (disabled) button is hovered or focused with the keyboard
- **THEN** the shortened offline explanation is shown in a tooltip
- **AND** the wrapper element that carries the tooltip trigger is focusable (`tabIndex = 0`) so keyboard users can reveal it

#### Scenario: Only the offline hint changes

- **WHEN** the button transitions to its "started" state after a successful click
- **THEN** the existing "started" hint is shown unchanged
- **AND** the click-time agent-offline server-rejection message is shown unchanged when the server rejects a click

#### Scenario: Offline copy is short and localized

- **WHEN** the offline tooltip is shown
- **THEN** its text is a concise tooltip-sized phrase
- **AND** the phrase is defined in all four registered locale files (`en`, `zh`, `ko`, `ja`), preserving the existing `offlineHint` key name so locale key-parity is unaffected
