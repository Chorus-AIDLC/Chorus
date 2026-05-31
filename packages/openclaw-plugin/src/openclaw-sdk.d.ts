/**
 * Ambient module shim for the OpenClaw 2026.5.x Plugin SDK.
 *
 * WHY THIS EXISTS:
 * The plugin's runtime entry imports `definePluginEntry` from the subpath
 * `openclaw/plugin-sdk/plugin-entry`. That subpath export only exists in the
 * OpenClaw 2026.5.30 Plugin SDK. The `openclaw` package currently resolvable in
 * this workspace's node_modules is an older build (2026.3.x) that does NOT
 * export `./plugin-sdk/plugin-entry`, so `tsc` cannot resolve the import from
 * the real package and would fail type-checking.
 *
 * Rather than bundle/install the full 2026.5.30 OpenClaw package just to satisfy
 * `tsc --noEmit`, we declare a minimal ambient module with a permissive
 * signature. At install/runtime the real host provides the actual SDK
 * (the package.json `peerDependencies.openclaw` floor + the
 * `openclaw.compat.pluginApi >=2026.5.30` gate enforce the version contract);
 * this declaration is purely a compile-time bridge.
 *
 * The signature mirrors `definePluginEntry` from
 * `../openclaw/src/plugin-sdk/plugin-entry.ts` (verified against OpenClaw
 * 2026.5.30). `api` is typed `unknown`-ish via a permissive shape so the entry
 * file stays readable without pulling in the full `OpenClawPluginApi` type
 * graph. When the workspace upgrades to an `openclaw` build that exports
 * `plugin-sdk/plugin-entry`, delete this shim and rely on the real types.
 */
declare module "openclaw/plugin-sdk/plugin-entry" {
  /** Public registration modes surfaced to plugin `register(api)` calls. */
  export type PluginRegistrationMode =
    | "full"
    | "discovery"
    | "tool-discovery"
    | "setup-only"
    | "setup-runtime"
    | "cli-metadata";

  /** JSON-Schema / parser config contract accepted by plugin entries. */
  export type OpenClawPluginConfigSchema = {
    safeParse?: (value: unknown) => unknown;
    parse?: (value: unknown) => unknown;
    validate?: (value: unknown) => unknown;
    uiHints?: Record<string, unknown>;
    jsonSchema?: Record<string, unknown>;
  };

  /**
   * Permissive subset of `OpenClawPluginApi` used by this plugin's entry.
   *
   * Only the members this plugin touches are typed; the index signature keeps
   * the rest of the (large) host API accessible without importing it.
   */
  export type OpenClawPluginApi = {
    registrationMode: PluginRegistrationMode;
    pluginConfig?: Record<string, unknown>;
    config?: Record<string, unknown> & {
      gateway?: { port?: number };
      hooks?: { token?: string };
    };
    logger: {
      debug?: (message: string) => void;
      info: (message: string) => void;
      warn: (message: string) => void;
      error: (message: string) => void;
    };
    registerService: (service: {
      id: string;
      start: (...args: unknown[]) => void | Promise<void>;
      stop?: (...args: unknown[]) => void | Promise<void>;
    }) => void;
    registerCommand: (command: unknown) => void;
    registerTool: (tool: unknown, opts?: unknown) => void;
    runtime?: unknown;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [key: string]: any;
  };

  export type DefinePluginEntryOptions = {
    id: string;
    name: string;
    description: string;
    configSchema?: OpenClawPluginConfigSchema | (() => OpenClawPluginConfigSchema);
    register: (api: OpenClawPluginApi) => void;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [key: string]: any;
  };

  export type DefinedPluginEntry = {
    id: string;
    name: string;
    description: string;
    configSchema: OpenClawPluginConfigSchema;
    register: (api: OpenClawPluginApi) => void;
  };

  export function definePluginEntry(options: DefinePluginEntryOptions): DefinedPluginEntry;
}
