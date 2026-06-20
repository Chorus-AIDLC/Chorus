# openclaw-plugin-sdk Specification

## ADDED Requirements

### Requirement: The plugin SHALL type the real runtime agent and session surface it consumes

The plugin's SDK declaration (`openclaw-sdk.d.ts` or an imported equivalent) SHALL declare the real shapes of the OpenClaw runtime surface the daemon work consumes, replacing the opaque `runtime?: unknown` placeholder, so these calls are compile-time checked rather than `unknown`-cast. The declared surface SHALL include `runtime.agent.runEmbeddedAgent(params)` with at least the `abortSignal?: AbortSignal` parameter and the per-message streaming callbacks the plugin passes (assistant-message / block callbacks), the result fields the plugin reads (e.g. `meta.aborted`), and the session helpers `runtime.agent.session.getSessionEntry` and `resolveSessionFilePath`. The declared shapes SHALL be verified against the real `../openclaw` source rather than guessed.

#### Scenario: runEmbeddedAgent is typed with abortSignal and streaming callbacks

- **WHEN** the plugin's SDK declaration is read
- **THEN** `runtime.agent.runEmbeddedAgent` MUST be declared with an `abortSignal?: AbortSignal` parameter and the per-message streaming callback parameters the plugin uses
- **AND** `runtime` MUST NOT be declared as bare `unknown` for the surface the plugin calls

#### Scenario: Session helpers are typed

- **WHEN** the plugin resolves a session for resume/deliver_turn
- **THEN** `runtime.agent.session.getSessionEntry` and `resolveSessionFilePath` MUST be declared with their real parameter and return shapes
- **AND** the plugin's call sites MUST type-check against them without an `unknown` cast

#### Scenario: Declared shapes match the real SDK

- **WHEN** the declared surface is compared against the real `../openclaw` plugin SDK source
- **THEN** the declared parameter and result shapes MUST match the real types (verified against source, not LLM memory)
- **AND** where the published `openclaw` plugin-sdk type definitions are cleanly importable, the plugin SHALL prefer importing them over hand-declaring a parallel shim

### Requirement: The typed SDK surface SHALL NOT add a build-time hard dependency on the full openclaw package

Declaring or importing the real SDK types SHALL NOT introduce a hard runtime dependency on the full `openclaw` package into the separately-published `@chorus-aidlc/chorus-openclaw-plugin` build, and SHALL NOT add native bindings or postinstall scripts. If the published `openclaw` plugin-sdk types cannot be consumed without coupling the build to the full package, the plugin SHALL hand-declare only the minimal used surface instead.

#### Scenario: The plugin package still builds standalone

- **WHEN** the plugin package is built and packed
- **THEN** typing the SDK surface MUST NOT require the full `openclaw` package as a runtime dependency
- **AND** it MUST NOT introduce a postinstall script or a native-binding dependency
