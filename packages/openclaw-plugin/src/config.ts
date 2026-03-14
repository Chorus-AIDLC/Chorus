import { z } from "zod";

export const CONFIG_FILE_PATH = "~/.openclaw/openclaw.json";
export const CONFIG_KEY_PATH = "plugins.entries.chorus-openclaw-plugin.config";

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
  projectUuids: z
    .array(z.string().uuid())
    .optional()
    .default([])
    .describe("Project UUIDs to monitor. Empty = all projects"),
  autoStart: z
    .boolean()
    .optional()
    .default(true)
    .describe("Auto-claim and start work on task_assigned events"),
});

export type ChorusPluginConfig = z.infer<typeof chorusConfigSchema>;

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
