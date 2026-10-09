import { appendFileSync, statSync } from "node:fs";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

export default function (pi) {
  pi.registerProvider("chorus-child-fixture", {
    api: "chorus-child-fixture-api", apiKey: "fixture-only", baseUrl: "http://127.0.0.1",
    models: [{ id: "deterministic", name: "Child role regression driver", reasoning: false,
      input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000, maxTokens: 4096 }],
    streamSimple(model, context) {
      const texts = context.messages.filter((message) => message.role === "user").flatMap((message) =>
        typeof message.content === "string" ? [message.content] : message.content
          .filter((part) => part.type === "text").map((part) => part.text));
      const instruction = texts.findLast((text) => text.includes("CHILD_ROLE_PROBE="));
      if (!instruction) throw new Error("Missing child role fixture instruction");
      const probe = JSON.parse(instruction.slice(instruction.indexOf("CHILD_ROLE_PROBE=") +
        "CHILD_ROLE_PROBE=".length).split("\n")[0]);
      const results = context.messages.filter((message) => message.role === "toolResult" &&
        message.toolCallId.startsWith(`role-${probe.id}-`));
      const action = probe.actions[results.length];
      appendFileSync(process.env.CHORUS_CHILD_MODEL_LOG, JSON.stringify({
        pid: process.pid, piVersion: VERSION, id: probe.id, completed: results.length,
        networkBytes: statSync(process.env.CHORUS_CHILD_NETWORK_LOG).size,
        connectionEnv: { url: process.env.CHORUS_URL !== undefined, apiKey: process.env.CHORUS_API_KEY !== undefined },
        sessionUuid: /Session UUID: ([^\s]+)/.exec(instruction)?.[1] ?? null,
        activeTools: pi.getActiveTools(), registry: pi.getAllTools().map((tool) => tool.name),
        results,
      }) + "\n");
      const message = { role: "assistant", content: action ? [{ type: "toolCall",
        id: `role-${probe.id}-${results.length}`, name: action.name, arguments: action.arguments ?? {} }]
        : [{ type: "text", text: `child-role-complete:${probe.id}` }],
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
