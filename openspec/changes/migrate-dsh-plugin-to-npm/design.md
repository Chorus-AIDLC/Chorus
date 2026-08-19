## Context

The shared worktree already contains the dsh daemon bridge, a Chorus lifecycle Cordis plugin, adapted skills, onboarding, and live-acceptance work. Their current delivery mechanism is transitional: `install-dsh.sh` downloads a built lifecycle artifact, writes credentials and Cordis rows under `$DSH_HOME`, and copies skills, instructions, and a named preset into dsh-owned directories.

The pinned DeepSeek Harness source proves a native alternative. `dsh plugin --profile <name> add <package>` reconciles dependencies whose `package.json` declares `dsh.bundle.patch` into `dsh.profile.bundles`; Loader resolves package names from the composition base URL; filesystem skills accept arbitrary absolute directories; and the built-in Cordis preset points at package-local skills through `baseUrl`. The daemon plane is different: `dsh-jsonrpc-agent` boots an explicit Cordis config and does not consume an interactive profile, so Chorus must prepare a resolvable npm installation and config for that plane.

## Goals / Non-Goals

**Goals:**

- Make the public npm package the sole distribution unit for all Chorus-owned dsh client artifacts.
- Preserve existing lifecycle, MCP, skills, persona/instruction, transcript, usage, and interruption behavior.
- Avoid all writes to `$DSH_HOME` by Chorus code and keep credentials out of package/config artifacts by default.
- Support interactive profile installation and daemon JSON-RPC startup from the same package release.
- Keep the published package pure JavaScript and portable across dsh-supported platforms.

**Non-Goals:**

- Distribute dsh itself or assume ownership of dsh's native dependencies such as `node-pty` or `koffi`.
- Change Chorus MCP APIs, daemon turn correlation, token normalization, or reviewer semantics.
- Add a named Chorus agent preset; bundle-level composition is the supported path.
- Support the old curl/home-copy installer as a compatibility fallback.
- Merge or publish the package automatically; release and integration remain human-gated.

## Decisions

### Publish one native dsh bundle package

`@chorus-aidlc/chorus-dsh` becomes public and declares:

```json
{
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    }
  }
}
```

Its published `files` contain the self-contained ESM runtime, declarations as appropriate, `cordis.patch.yml`, packaged skills, and package documentation. The package has no native dependency. `@deepseek-ai/schemastery` is the only `dependencies` entry required by Chorus-owned runtime code; runtime code is bundled by esbuild.

The patch also mounts four host plugins by package name, so the package declares these verified `0.1.0-rc.7` packages as non-optional `peerDependencies` rather than bundling or vendoring them:

- `@deepseek-ai/dsh-mcp-client`
- `@deepseek-ai/dsh-skill-filesystem`
- `@deepseek-ai/dsh-tool-skill`
- `@deepseek-ai/dsh-persona`

Other dsh/Cordis packages used only for type and contract checks remain development dependencies. This reconciles the schemastery-only owned-runtime rule with Loader's requirement that YAML `name:` entries resolve from the active composition.

Alternative considered: keep publishing the generated runtime from the Chorus web server. Rejected because it preserves two release channels, cannot carry the complete bundle contract naturally, and requires custom installation into user-owned state.

### Compose prompt, tools, and skills at bundle level

The patch mounts the existing lifecycle plugin plus `@deepseek-ai/dsh-mcp-client` and a dedicated `@deepseek-ai/dsh-skill-filesystem` provider directly. It targets the profile/base `@deepseek-ai/dsh-tool-skill` row by ID instead of inserting a duplicate, because two instances race the same durable session hooks; the daemon managed composition supplies that row before applying the bundle layer. A package controller imports the fourth declared peer, `@deepseek-ai/dsh-persona`, by package name and mounts it through each agent's scoped context. The indirection is required because the pinned persona implementation explicitly rejects a root mount that collides with the deployment persona (`packages/preset/persona/src/index.ts:1-10,34-52`). `customSkillDirs` resolves the package-local `skills/` directory with `createRequire(baseUrl)`, following dsh's Loader resolution contract. The persona controller passes the pinned plugin's required inline `text` field; Chorus operating instructions are supplied in that text without a named preset or `dshHome` path.

The package entry exposes a schema for optional `url` and `apiKey` values. Effective values use explicit plugin config first and otherwise read `process.env.CHORUS_URL` and `process.env.CHORUS_API_KEY`. The patch and generated daemon config contain environment expressions, never resolved secrets.

Alternative considered: point `AgentPresets.Config.roots` at a package-local named preset. Rejected because it adds a second registration path and menu concept that is unnecessary for Chorus activation.

### Treat interactive and daemon boot as two consumers of one package

Interactive users install the bundle into a chosen dsh profile with:

```bash
dsh plugin --profile <name> add @chorus-aidlc/chorus-dsh
```

dsh forwards this operation to pnpm, so both dsh and pnpm are explicit prerequisites. dsh owns that profile dependency and bundle reconciliation. The profile/base installation satisfies the four declared peers. Chorus performs no profile or `$DSH_HOME` writes.

For daemon-owned sessions, Chorus prepares a managed Node project and generated Cordis config in a Chorus-owned state directory. Preparation explicitly installs the same Chorus package version plus its four declared peer packages at the pinned-compatible dsh version into that project's `node_modules`, without shell interpolation. The config is colocated with that resolution anchor, so Loader can import every peer `name:` row. Preparation writes a secret-free config and validates that all five named modules and the complete composition load.

The generated config first references `@chorus-aidlc/chorus-dsh` by package name. If that package-name import cannot resolve, preparation emits its resolved absolute entry path instead; the four peer plugins remain resolvable by name from the managed config directory. `CHORUS_DSH_CONFIG` / `DSH_CORDIS_CONFIG` remain explicit operator overrides and are never rewritten.

Alternative considered: require every daemon operator to hand-author a config. Rejected because the daemon integration should be installable and bootable from Chorus-managed state. Always using an absolute path was also rejected because package-name resolution is the native, relocation-friendly contract.

### Delete the old distribution surface atomically

The implementation removes the hosted installer, generated public runtime, copied skill/preset tree, and installer-specific tests in the same change that enables package installation and rewrites onboarding. There is no deprecation window because these artifacts have not shipped as a stable public contract and the elaboration explicitly selects npm-only replacement.

The source skills move under the package (or are generated there by a deterministic package build step) so npm pack is the reviewed distribution boundary. No build copies the runtime back into `public/`.

### Verify the tarball and both real boot planes

Deterministic tests inspect `npm pack --json`/equivalent output for metadata and required files, install the tarball into an isolated dsh profile, and assert no Chorus process writes beneath a sentinel `$DSH_HOME`. Contract checks remain pinned to `dsh-v0.1.0-rc.7` / `99f6f02f`.

Live acceptance covers:

- interactive bundle installation, effective composition, check-in, skill discovery/loading, and inline persona/instructions;
- daemon managed install/config startup, real wake, transcript, per-Idea normalized usage, and process-group interruption;
- credentials sourced from environment with no key in package files, generated config, argv, or logs;
- absence of `install-dsh.sh`, `/chorus-dsh.mjs`, and copied-home behavior.

## Risks / Trade-offs

- [dsh bundle or Loader contracts change before a stable release] -> Pin source-contract and real-composition tests to the verified commit; advance the baseline deliberately.
- [Daemon package installation needs registry/network access] -> Perform preparation during daemon installation or explicit setup, cache the managed install, validate before service activation, and fail with an actionable error rather than downloading during every wake.
- [A package manager treats peer declarations as warnings or resolves them outside the config anchor] -> Install the exact four peers explicitly in the daemon-managed project and validate each name from the generated config directory before service activation.
- [Package-name resolution differs across npm/pnpm layouts] -> Anchor config in the managed project and retain the verified absolute-entry fallback.
- [Inline credentials could be accidentally serialized] -> Keep env fallback in runtime evaluation, add secret-scanning assertions, and never pass values in argv.
- [Deleting copied skill sources can lose release files] -> Make packed-tarball membership and real skill discovery required tests.
- [A shared dirty worktree contains sibling dsh changes] -> Restrict edits to this migration and preserve all existing behavior not explicitly replaced.

## Migration Plan

1. Reshape and validate `@chorus-aidlc/chorus-dsh` as the complete public bundle, declare its four dsh peers, and stop copying build output into `public/`.
2. Add daemon managed installation of the package plus all four peers, generated config validation, and explicit config override preservation.
3. Switch onboarding and documentation to npm installation with dsh and pnpm prerequisites.
4. Remove the remaining hosted/copy installer artifacts and obsolete tests.
5. Run package, unit, contract, and pinned real dsh acceptance across both boot planes.
6. Submit the integrated change for human-controlled publication and merge.

Rollback before publication reverts the integrated change. After publication, rollback pins the prior Chorus release and removes the package from affected dsh profiles using dsh's plugin management; Chorus does not restore the removed home-copy installer.

## Open Questions

None. The elaboration fixes package shape, credential precedence, daemon resolution, preset disposition, removal scope, versioning, and acceptance depth.
