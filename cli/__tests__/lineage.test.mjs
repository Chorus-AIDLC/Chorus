// cli/__tests__/lineage.test.mjs
// Covers cli-daemon spec "Lineage-anchored session continuity" (resolution half).
// Resolution is a single REST call per notification to
//   GET /api/entities/{type}/{uuid}/root-idea
// with no client-side lineage walk. These tests drive a fake fetch.
import { describe, it, expect } from "vitest";
import { LineageResolver } from "../lineage.mjs";

const silent = { info() {}, warn() {}, error() {} };

/** A fake fetch that records requested URLs and replies from a handler. */
function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  fn.calls = calls;
  return fn;
}

/** Build a JSON Response-like object (matches the subset LineageResolver uses). */
function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    async json() {
      return body;
    },
  };
}

/** Standard success envelope from the REST endpoint. */
function rootIdeaData(data) {
  return jsonResponse({ success: true, data });
}

const BASE = "http://chorus.test";

function makeResolver(fetchImpl, logger = silent) {
  return new LineageResolver({ url: BASE, apiKey: "cho_test", logger, fetchImpl });
}

describe("LineageResolver.rootIdeaFor (REST)", () => {
  it("resolves an entity by calling the root-idea endpoint and using rootIdeaUuid", async () => {
    const fetchImpl = fakeFetch(() =>
      rootIdeaData({ rootIdeaUuid: "root-idea", lineage: [], resolvedVia: "via_proposal" })
    );
    const r = makeResolver(fetchImpl);
    const root = await r.rootIdeaFor({ entityType: "task", entityUuid: "t1" });

    expect(root).toBe("root-idea");
    expect(fetchImpl.calls).toHaveLength(1);
    expect(fetchImpl.calls[0].url).toBe(`${BASE}/api/entities/task/t1/root-idea`);
  });

  it("resolve() returns BOTH the root and the direct idea from one call", async () => {
    const fetchImpl = fakeFetch(() =>
      rootIdeaData({
        rootIdeaUuid: "root-idea",
        directIdeaUuid: "direct-idea",
        lineage: [],
        resolvedVia: "via_proposal",
      })
    );
    const r = makeResolver(fetchImpl);
    const res = await r.resolve({ entityType: "task", entityUuid: "t1" });

    expect(res).toEqual({ rootIdeaUuid: "root-idea", directIdeaUuid: "direct-idea" });
    expect(fetchImpl.calls).toHaveLength(1);
  });

  it("resolve() treats a missing directIdeaUuid (older server) as null without failing root", async () => {
    const fetchImpl = fakeFetch(() => rootIdeaData({ rootIdeaUuid: "root-idea", lineage: [] }));
    const r = makeResolver(fetchImpl);
    const res = await r.resolve({ entityType: "task", entityUuid: "t1" });

    expect(res).toEqual({ rootIdeaUuid: "root-idea", directIdeaUuid: null });
  });

  it("resolve() returns both null on failure (caller falls back to a per-entity key)", async () => {
    const fetchImpl = fakeFetch(() => jsonResponse({ success: false }, { ok: false, status: 500 }));
    const r = makeResolver(fetchImpl);
    expect(await r.resolve({ entityType: "task", entityUuid: "t" })).toEqual({
      rootIdeaUuid: null,
      directIdeaUuid: null,
    });
  });

  it("resolve() short-circuits daemon_session (no idea ancestor) WITHOUT a request", async () => {
    // An ad-hoc conversation has no idea lineage and the root-idea endpoint rejects the
    // type (400). Short-circuiting avoids a guaranteed-failing round-trip + spurious warn
    // on every ad-hoc resume; the caller then anchors on the entity uuid (= sessionId).
    const fetchImpl = fakeFetch(() => rootIdeaData({ rootIdeaUuid: "x", directIdeaUuid: "y" }));
    const r = makeResolver(fetchImpl);
    expect(await r.resolve({ entityType: "daemon_session", entityUuid: "sid-1" })).toEqual({
      rootIdeaUuid: null,
      directIdeaUuid: null,
    });
    expect(fetchImpl.calls).toHaveLength(0); // no network for daemon_session
  });

  it("resolve() caches both ids within a run (one request per entity)", async () => {
    const fetchImpl = fakeFetch(() =>
      rootIdeaData({ rootIdeaUuid: "r", directIdeaUuid: "d" })
    );
    const r = makeResolver(fetchImpl);
    await r.resolve({ entityType: "idea", entityUuid: "solo" });
    const second = await r.resolve({ entityType: "idea", entityUuid: "solo" });
    expect(second).toEqual({ rootIdeaUuid: "r", directIdeaUuid: "d" });
    expect(fetchImpl.calls).toHaveLength(1); // served from cache
  });

  it("sends the Bearer agent key", async () => {
    const fetchImpl = fakeFetch(() => rootIdeaData({ rootIdeaUuid: "x" }));
    const r = new LineageResolver({ url: BASE, apiKey: "cho_secret", logger: silent, fetchImpl });
    await r.rootIdeaFor({ entityType: "idea", entityUuid: "i" });

    expect(fetchImpl.calls[0].init.headers.Authorization).toBe("Bearer cho_secret");
  });

  it("URL-encodes the entity type and uuid", async () => {
    const fetchImpl = fakeFetch(() => rootIdeaData({ rootIdeaUuid: null }));
    const r = makeResolver(fetchImpl);
    await r.rootIdeaFor({ entityType: "task", entityUuid: "weird/uuid?x=1" });

    expect(fetchImpl.calls[0].url).toBe(`${BASE}/api/entities/task/weird%2Fuuid%3Fx%3D1/root-idea`);
  });

  it("returns null when the server resolves to no idea ancestor", async () => {
    const fetchImpl = fakeFetch(() =>
      rootIdeaData({ rootIdeaUuid: null, lineage: [], resolvedVia: "no_proposal" })
    );
    const r = makeResolver(fetchImpl);
    expect(await r.rootIdeaFor({ entityType: "task", entityUuid: "t" })).toBeNull();
  });

  it("returns null (not throw) on a non-2xx response", async () => {
    const fetchImpl = fakeFetch(() => jsonResponse({ success: false }, { ok: false, status: 500 }));
    const r = makeResolver(fetchImpl);
    expect(await r.rootIdeaFor({ entityType: "task", entityUuid: "t" })).toBeNull();
  });

  it("returns null (not throw) when fetch rejects (server unreachable)", async () => {
    const fetchImpl = fakeFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    const r = makeResolver(fetchImpl);
    expect(await r.rootIdeaFor({ entityType: "task", entityUuid: "t" })).toBeNull();
  });

  it("returns null (not throw) on malformed JSON", async () => {
    const fetchImpl = fakeFetch(() => ({
      ok: true,
      status: 200,
      async json() {
        throw new Error("invalid json");
      },
    }));
    const r = makeResolver(fetchImpl);
    expect(await r.rootIdeaFor({ entityType: "task", entityUuid: "t" })).toBeNull();
  });

  it("returns null on an unexpected response shape (no data.rootIdeaUuid)", async () => {
    const fetchImpl = fakeFetch(() => jsonResponse({ success: true, data: { lineage: [] } }));
    const r = makeResolver(fetchImpl);
    expect(await r.rootIdeaFor({ entityType: "task", entityUuid: "t" })).toBeNull();
  });

  it("returns null when rootIdeaUuid is a non-string, non-null value", async () => {
    const fetchImpl = fakeFetch(() => rootIdeaData({ rootIdeaUuid: 42 }));
    const r = makeResolver(fetchImpl);
    expect(await r.rootIdeaFor({ entityType: "task", entityUuid: "t" })).toBeNull();
  });

  it("returns null (not throw, no request) on a missing entityUuid", async () => {
    const fetchImpl = fakeFetch(() => rootIdeaData({ rootIdeaUuid: "x" }));
    const r = makeResolver(fetchImpl);
    expect(await r.rootIdeaFor({ entityType: "task" })).toBeNull();
    expect(fetchImpl.calls).toHaveLength(0); // never hit the network
  });

  it("caches resolution within a run (one request per entity key)", async () => {
    const fetchImpl = fakeFetch(() => rootIdeaData({ rootIdeaUuid: "solo" }));
    const r = makeResolver(fetchImpl);
    await r.rootIdeaFor({ entityType: "idea", entityUuid: "solo" });
    await r.rootIdeaFor({ entityType: "idea", entityUuid: "solo" });
    expect(fetchImpl.calls).toHaveLength(1); // second served from cache
  });

  it("caches a null result too (no repeat request for a no-ancestor entity)", async () => {
    const fetchImpl = fakeFetch(() => rootIdeaData({ rootIdeaUuid: null }));
    const r = makeResolver(fetchImpl);
    await r.rootIdeaFor({ entityType: "task", entityUuid: "q" });
    await r.rootIdeaFor({ entityType: "task", entityUuid: "q" });
    expect(fetchImpl.calls).toHaveLength(1);
  });

  it("logs the resolution (no silent attribution)", async () => {
    const infos = [];
    const fetchImpl = fakeFetch(() =>
      rootIdeaData({ rootIdeaUuid: "r", resolvedVia: "root_idea" })
    );
    const r = makeResolver(fetchImpl, { ...silent, info: (m) => infos.push(m) });
    await r.rootIdeaFor({ entityType: "idea", entityUuid: "x" });
    expect(infos.some((m) => /lineage: idea:x → root r, direct none \(root_idea\)/.test(m))).toBe(true);
  });
});
