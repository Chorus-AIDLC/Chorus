import { describe, expect, it } from "vitest";
import { createTranscriptUploadHooks } from "../upload-hooks.mjs";

describe("exact transcript attribution", () => {
  it("keeps overlapping runs and delayed uploads on their admitted turns", async () => {
    const posts = [];
    let releaseFirst;
    const blocked = new Promise(resolve => { releaseFirst = resolve; });
    const hooks = createTranscriptUploadHooks({
      url: "https://isolated.invalid", apiKey: "synthetic", batchDelayMs: 60_000,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(init.body);
        if (body.turnUuid === "first") await blocked;
        posts.push(body);
        return { ok: true, status: 200, json: async () => ({ data: {} }) };
      },
    });
    const first = { sessionId: "same-session", turnUuid: "first" };
    const next = { sessionId: "same-session", turnUuid: "next" };
    await hooks.onSessionStart(first);
    await hooks.onTranscriptMessage({ ...first, message: { type: "assistant", message: { role: "assistant", content: "first reply" } } });
    const finishingFirst = hooks.onSessionEnd(first);
    await hooks.onSessionStart(next);
    await hooks.onTranscriptMessage({ ...next, message: { type: "assistant", message: { role: "assistant", content: "next reply" } } });
    await hooks.onSessionEnd(next);
    releaseFirst();
    await finishingFirst;
    expect(posts).toEqual([
      { turnUuid: "next", messages: [{ role: "assistant", text: "next reply" }] },
      { turnUuid: "first", messages: [{ role: "assistant", text: "first reply" }] },
    ]);
  });
});
