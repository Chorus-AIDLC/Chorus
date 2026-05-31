## ADDED Requirements

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
