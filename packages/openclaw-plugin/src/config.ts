import { z } from "zod";

export const CONFIG_FILE_PATH = "~/.openclaw/openclaw.json";
export const CONFIG_KEY_PATH = "plugins.entries.chorus-openclaw-plugin.config";

/**
 * In-code zod schema for typing `api.pluginConfig`.
 *
 * The canonical config contract is the JSON-Schema `configSchema` in
 * `openclaw.plugin.json`, which OpenClaw validates BEFORE plugin code runs.
 * This zod schema exists only for in-code typing and friendly missing-field
 * messages — its accepted property set (chorusUrl, apiKey) MUST stay identical
 * to the manifest `configSchema.properties`.
 */
export const chorusConfigSchema = z.object({
  chorusUrl: z
    .string()
    .url()
    .optional()
    .describe("Chorus server URL (e.g. https://chorus.example.com)"),
  apiKey: z
    .string()
    .startsWith("cho_")
    .optional()
    .describe("Chorus API Key (cho_ prefix)"),
});

export type ChorusPluginConfig = z.infer<typeof chorusConfigSchema>;

/**
 * Normalize a raw `api.pluginConfig` bag into a typed `ChorusPluginConfig`.
 *
 * The host has already validated the bag against the manifest JSON Schema, so
 * this only fills defaults and narrows types; it does not re-validate shape.
 */
export function resolveConfig(pluginConfig: Record<string, unknown> | undefined): ChorusPluginConfig {
  const raw = pluginConfig ?? {};
  return {
    chorusUrl: (raw.chorusUrl as string | undefined) || undefined,
    apiKey: (raw.apiKey as string | undefined) || undefined,
  };
}

/**
 * Check required config fields and warn about missing ones.
 * Returns true if all required fields are present, false otherwise.
 */
export function validateConfigWithWarnings(
  config: ChorusPluginConfig,
  logger: { warn: (msg: string) => void },
): boolean {
  const missing: string[] = [];

  if (!config.chorusUrl) {
    missing.push(`  - "chorusUrl": set at ${CONFIG_KEY_PATH}.chorusUrl in ${CONFIG_FILE_PATH}`);
  }
  if (!config.apiKey) {
    missing.push(`  - "apiKey": set at ${CONFIG_KEY_PATH}.apiKey in ${CONFIG_FILE_PATH}`);
  }

  if (missing.length > 0) {
    logger.warn(
      `[Chorus] Plugin is missing required configuration. Features will be disabled until configured:\n` +
      missing.join("\n")
    );
    return false;
  }
  return true;
}
