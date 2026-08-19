import type { Context } from "@deepseek-ai/cordis";
import * as Persona from "@deepseek-ai/dsh-persona";
import z from "@deepseek-ai/schemastery";

export const name = "chorus-dsh-persona";

export interface Config {
  plugin?: string;
  text: string;
}

export const Config: z<Config> = z.object({
  plugin: z
    .string()
    .default("@deepseek-ai/dsh-persona")
    .pattern(/^@deepseek-ai\/dsh-persona$/),
  text: z.string().required(),
});

export function apply(ctx: Context, config: Config): void {
  const resolved = Config(config);
  ctx.on("agent/created", ({ agent }) => {
    agent.ctx.plugin(Persona, { text: resolved.text });
  });
}
