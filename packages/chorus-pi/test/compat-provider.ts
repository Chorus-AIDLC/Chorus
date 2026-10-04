import { appendFileSync } from "node:fs";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

export default function (pi) {
  pi.registerProvider("chorus-fixture", {
    api: "chorus-fixture-api", apiKey: "dummy-local-only", baseUrl: "http://127.0.0.1",
    models: [{ id: "deterministic", name: "Local deterministic compatibility driver", reasoning: false,
      input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000, maxTokens: 4096 }],
    streamSimple(model, context) {
      const texts = context.messages.filter((message) => message.role === "user").flatMap((message) =>
        typeof message.content === "string" ? [message.content] : message.content
          .filter((part) => part.type === "text").map((part) => part.text));
      const text = texts.findLast((value) => value.includes("COMPAT_PROBE="));
      if (!text) throw new Error("No deterministic compatibility instruction");
      const probe = JSON.parse(text.slice(text.indexOf("COMPAT_PROBE=") + "COMPAT_PROBE=".length).split("\n")[0]);
      const completed = context.messages.filter((message) => message.role === "toolResult" &&
        message.toolCallId.startsWith(`compat-${probe.id}-`)).length;
      const action = probe.actions[completed];
      appendFileSync(process.env.CHORUS_COMPAT_MODEL_LOG, JSON.stringify({
        pid: process.pid, id: probe.id, completed, tools: pi.getActiveTools(),
        hasSessionWorkflow: text.includes("Chorus session (auto-injected"),
        messages: context.messages.filter((message) => message.role === "toolResult"),
      }) + "\n");
      const message = { role: "assistant", content: action ? [{ type: "toolCall",
        id: `compat-${probe.id}-${completed}`, name: action.name, arguments: action.arguments ?? {} }]
        : [{ type: "text", text: `compat-complete:${probe.id}` }],
      api: model.api, provider: model.provider, model: model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: action ? "toolUse" : "stop", timestamp: Date.now() };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: message.stopReason, message });
        stream.end();
      });
      return stream;
    },
  });
}
