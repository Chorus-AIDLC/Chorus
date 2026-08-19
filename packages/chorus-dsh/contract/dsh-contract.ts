import type { Context } from "@deepseek-ai/cordis";
import type { Agent, PreStepDecision } from "@deepseek-ai/dsh-agent";
import type { PostToolDecision, ToolExecutionResult } from "@deepseek-ai/dsh-tools";
import { Config, apply, inject, name, type Config as PluginConfig } from "../src/index.js";
import {
  Config as PersonaConfig,
  apply as applyPersona,
  type Config as PersonaPluginConfig,
} from "../src/persona.js";

const pluginName: string = name;
const pluginInject: string[] = inject;
const schemaValue: PluginConfig = Config({});
const pluginApply: (ctx: Context, config: PluginConfig) => void = apply;
const personaSchema: PersonaPluginConfig = PersonaConfig({
  text: "Chorus",
});
const personaApply: (ctx: Context, config: PersonaPluginConfig) => void =
  applyPersona;

declare const context: Context;
declare const agent: Agent;
declare const toolResult: ToolExecutionResult;
declare const preStepDecision: PreStepDecision;
declare const postToolDecision: PostToolDecision;

void [
  pluginName,
  pluginInject,
  schemaValue,
  pluginApply,
  personaSchema,
  personaApply,
  context,
  agent,
  toolResult,
  preStepDecision,
  postToolDecision,
];
