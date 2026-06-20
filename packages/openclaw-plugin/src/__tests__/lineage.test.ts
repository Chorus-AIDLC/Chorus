import { describe, it, expect, vi } from "vitest";
import { LineageResolver } from "../lineage.js";

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeFetch(impl: (url: string) => Response | Promise<Response>) {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (url: string) => {
    calls.push(url);
    return impl(url);
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

describe("LineageResolver", () => {
  it("resolves { rootIdeaUuid, directIdeaUuid } from the root-idea endpoint with Bearer auth", async () => {
    const { fetchImpl, calls } = makeFetch(() =>
      new Response(JSON.stringify({ success: true, data: { rootIdeaUuid: "root-1", directIdeaUuid: "direct-1", resolvedVia: "task" } }), { status: 200 }),
    );
    const r = new LineageResolver({ url: "https://chorus.example.com/", apiKey: "cho_x", fetchImpl });
    const out = await r.resolve({ entityType: "task", entityUuid: "task-9" });
    expect(out).toEqual({ rootIdeaUuid: "root-1", directIdeaUuid: "direct-1" });
    expect(calls[0]).toBe("https://chorus.example.com/api/entities/task/task-9/root-idea");
  });

  it("caches per entity (single-flights repeats)", async () => {
    const { fetchImpl, calls } = makeFetch(() =>
      new Response(JSON.stringify({ success: true, data: { rootIdeaUuid: "root-1", directIdeaUuid: "direct-1" } }), { status: 200 }),
    );
    const r = new LineageResolver({ url: "https://x", apiKey: "k", fetchImpl });
    await r.resolve({ entityType: "task", entityUuid: "t" });
    await r.resolve({ entityType: "task", entityUuid: "t" });
    expect(calls.length).toBe(1);
  });

  it("short-circuits daemon_session (no idea ancestor) without a round-trip", async () => {
    const { fetchImpl, calls } = makeFetch(() => new Response("{}", { status: 200 }));
    const r = new LineageResolver({ url: "https://x", apiKey: "k", fetchImpl });
    const out = await r.resolve({ entityType: "daemon_session", entityUuid: "s-1" });
    expect(out).toEqual({ rootIdeaUuid: null, directIdeaUuid: null });
    expect(calls.length).toBe(0);
  });

  it("returns both null on a non-2xx (caller falls back to a per-entity key)", async () => {
    const logger = makeLogger();
    const { fetchImpl } = makeFetch(() => new Response("err", { status: 500 }));
    const r = new LineageResolver({ url: "https://x", apiKey: "k", fetchImpl, logger });
    const out = await r.resolve({ entityType: "task", entityUuid: "t" });
    expect(out).toEqual({ rootIdeaUuid: null, directIdeaUuid: null });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("server returned 500"));
  });

  it("tolerates a missing directIdeaUuid (older server) as null", async () => {
    const { fetchImpl } = makeFetch(() =>
      new Response(JSON.stringify({ success: true, data: { rootIdeaUuid: "root-1" } }), { status: 200 }),
    );
    const r = new LineageResolver({ url: "https://x", apiKey: "k", fetchImpl });
    expect(await r.resolve({ entityType: "task", entityUuid: "t" })).toEqual({
      rootIdeaUuid: "root-1",
      directIdeaUuid: null,
    });
  });
});
