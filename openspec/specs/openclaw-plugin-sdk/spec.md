# openclaw-plugin-sdk Specification

## Purpose
TBD - created by archiving change refactor-openclaw-plugin. Update Purpose after archive.
## Requirements
### Requirement: The plugin SHALL declare its entry via the OpenClaw 2026.5.x Plugin SDK

The plugin's runtime entry module (`packages/openclaw-plugin/src/index.ts`) MUST default-export the result of `definePluginEntry(...)` imported from `openclaw/plugin-sdk/plugin-entry`. The legacy plain `{ id, register }` object literal MUST be removed. The entry MUST provide `id`, `name`, `description`, a `configSchema`, and a `register(api)` callback.

#### Scenario: Entry is a definePluginEntry default export

- **WHEN** `src/index.ts` is read
- **THEN** it MUST import `definePluginEntry` from `openclaw/plugin-sdk/plugin-entry`
- **AND** its default export MUST be the value returned by a `definePluginEntry({ ... })` call
- **AND** it MUST NOT export a bare object literal that relies on the pre-2026.5 `api`-object loader

#### Scenario: Entry id matches the manifest id

- **GIVEN** the manifest `openclaw.plugin.json` and the entry `src/index.ts`
- **WHEN** both are read
- **THEN** the `id` passed to `definePluginEntry` MUST equal the `id` field in `openclaw.plugin.json`

#### Scenario: Heavy runtime wiring is gated to full registration mode

- **WHEN** `register(api)` runs with `api.registrationMode` not equal to `"full"` (e.g. `"discovery"` or `"cli-metadata"`)
- **THEN** the plugin MUST NOT open the SSE socket, MUST NOT connect the MCP client, and MUST NOT mutate OpenClaw config
- **AND** when `api.registrationMode === "full"`, the plugin MUST perform its normal runtime wiring

### Requirement: The manifest SHALL use a JSON-Schema configSchema discoverable without executing plugin code

`openclaw.plugin.json` MUST contain an `id` and a JSON-Schema `configSchema` object that OpenClaw can read before loading plugin code. The schema MUST describe `chorusUrl`, `apiKey`, `projectUuids`, and `autoStart`, and MUST set `additionalProperties: false`. The `apiKey` field MUST be marked sensitive via `uiHints` so setup UIs mask it.

#### Scenario: Manifest exposes a JSON-Schema config without code execution

- **WHEN** `openclaw.plugin.json` is parsed as JSON5
- **THEN** it MUST contain a top-level `id` string and a `configSchema` object whose `type` is `"object"`
- **AND** `configSchema.properties` MUST include `chorusUrl`, `apiKey`, `projectUuids`, and `autoStart`
- **AND** `configSchema.additionalProperties` MUST be `false`

#### Scenario: API key field is marked sensitive

- **WHEN** `openclaw.plugin.json` is read
- **THEN** it MUST contain a `uiHints` entry for `apiKey` whose `sensitive` value is `true`

#### Scenario: In-code config validation stays aligned with the manifest

- **GIVEN** the zod schema retained in `src/config.ts` for in-code typing
- **WHEN** it is compared with the manifest `configSchema`
- **THEN** the set of accepted property names MUST be identical in both
- **AND** neither MUST accept a property the other rejects

### Requirement: The package SHALL declare OpenClaw entry, compatibility, and install metadata

`package.json` MUST carry an `openclaw` block declaring `extensions` (source entry), `runtimeExtensions` (built entry), `compat.pluginApi`, `build.openclawVersion`, and an `install` block enabling `openclaw plugins install npm:...`. The `compat.pluginApi` floor MUST be `>=2026.5.30`. The build MUST emit the `runtimeExtensions` target. The exact `compat`/`build`/`install` field set MUST match an externally-published bundled extension (e.g. `../openclaw/extensions/acpx/package.json`) verified against the installed SDK; fields not present in that reference (e.g. `compat.minGatewayVersion`, `build.pluginSdkVersion`) MUST NOT be added unless `openclaw plugins validate` requires them.

#### Scenario: openclaw block declares entries, compat floor, and install spec

- **WHEN** `package.json` is read
- **THEN** `openclaw.extensions` MUST point at the TypeScript source entry (`./src/index.ts`)
- **AND** `openclaw.runtimeExtensions` MUST point at the built entry (`./dist/index.js`)
- **AND** `openclaw.compat.pluginApi` MUST be `">=2026.5.30"`
- **AND** `openclaw.build.openclawVersion` MUST be present
- **AND** `openclaw.install.npmSpec` MUST equal the package name so the plugin is installable via `openclaw plugins install npm:<name>`

#### Scenario: Manifest fields match a verified reference extension

- **GIVEN** an externally-published bundled extension's `package.json` (e.g. `../openclaw/extensions/acpx/package.json`)
- **WHEN** the plugin's `openclaw` block is compared against it
- **THEN** the plugin MUST NOT declare a `compat`/`build` sub-field that the reference omits unless the installed `openclaw plugins validate` requires it

#### Scenario: Built entry exists after build

- **WHEN** the package build (`tsc`) runs
- **THEN** the file referenced by `openclaw.runtimeExtensions` MUST exist on disk
- **AND** it MUST be loadable as an ES module exporting the `definePluginEntry` result as default

#### Scenario: No native or postinstall dependencies

- **WHEN** `package.json` dependencies are inspected
- **THEN** there MUST be no `postinstall` script
- **AND** every runtime dependency MUST be pure JS/TS with no native bindings, so install under `--ignore-scripts` succeeds on linux-x64, linux-arm64, darwin-arm64, and win32

### Requirement: The built plugin SHALL pass the OpenClaw SDK validators

The plugin MUST pass `openclaw plugins build --entry ./dist/index.js --check` and `openclaw plugins validate` without errors. Any manifest field the installed validator requires (and only those) MUST be present, matched against a bundled reference extension when docs are ambiguous.

#### Scenario: SDK build-check passes on the built entry

- **WHEN** `openclaw plugins build --entry ./dist/index.js --check` is run against the built plugin
- **THEN** it MUST exit zero with no stale-metadata or missing-field errors

#### Scenario: SDK validate passes

- **WHEN** `openclaw plugins validate` is run against the plugin
- **THEN** it MUST report the manifest loads, the entry exports valid SDK metadata, and `openclaw.extensions`/`runtimeExtensions` resolve
- **AND** it MUST NOT report an unknown or missing required manifest field

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

