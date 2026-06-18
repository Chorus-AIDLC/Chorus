// cli/__tests__/interrupt-reporter.test.mjs
// Covers the REST interrupt reporter (子3 — daemon-interrupt-resume). The waker
// calls it on an interrupted/crashed exit; it POSTs the reason to the server's
// daemon-execution surface (keyed connection + entity) with the daemon's Bearer key
// and NEVER throws into the wake path. The interrupted state is entity-generic
// (task / idea / proposal / document) — it lives on the DaemonExecution row, not the
// Task model — so the reporter reports for ANY recognized entity kind and carries
// the daemon's own connectionUuid.
import { describe, it, expect, vi } from "vitest";
import { createInterruptReporter, INTERRUPT_REASONS } from "../interrupt-reporter.mjs";

const silent = { info() {}, warn() {}, error() {} };

function okFetch() {
  return vi.fn(async () => ({ ok: true, status: 200 }));
}

// A reporter whose connection handshake has completed (connectionUuid known).
function makeReporter(overrides = {}) {
  return createInterruptReporter({
    url: "https://chorus.example/",
    apiKey: "cho_secret",
    getConnectionUuid: () => "conn-1",
    logger: silent,
    fetchImpl: okFetch(),
    ...overrides,
  });
}

describe("createInterruptReporter", () => {
  it("POSTs reason=user to /api/daemon/report-interrupt with connection + entity + Bearer key", async () => {
    const fetchImpl = okFetch();
    const report = makeReporter({ fetchImpl });

    await report("task", "task-9", "user");

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://chorus.example/api/daemon/report-interrupt");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer cho_secret");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual({
      connectionUuid: "conn-1",
      entityType: "task",
      entityUuid: "task-9",
      reason: "user",
    });
  });

  it("POSTs reason=crash too", async () => {
    const fetchImpl = okFetch();
    const report = makeReporter({ fetchImpl });
    await report("task", "t1", "crash");
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toMatchObject({ reason: "crash" });
  });

  it("reports for non-task entities too (interrupted state is entity-generic)", async () => {
    const fetchImpl = okFetch();
    const report = makeReporter({ fetchImpl });
    await report("idea", "idea-1", "crash");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({
      connectionUuid: "conn-1",
      entityType: "idea",
      entityUuid: "idea-1",
      reason: "crash",
    });
  });

  it("refuses an unknown entity kind without POSTing", async () => {
    const warns = [];
    const fetchImpl = okFetch();
    const report = makeReporter({ fetchImpl, logger: { ...silent, warn: (m) => warns.push(m) } });
    await report("widget", "w1", "user");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(warns.join("")).toMatch(/bad entity\/reason/);
  });

  it("refuses an unknown reason without POSTing", async () => {
    const warns = [];
    const fetchImpl = okFetch();
    const report = makeReporter({ fetchImpl, logger: { ...silent, warn: (m) => warns.push(m) } });
    await report("task", "t1", "bogus");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(warns.join("")).toMatch(/bad entity\/reason/);
  });

  it("skips (logged) when no connection uuid is known yet; never POSTs", async () => {
    const warns = [];
    const fetchImpl = okFetch();
    const report = makeReporter({
      fetchImpl,
      getConnectionUuid: () => null,
      logger: { ...silent, warn: (m) => warns.push(m) },
    });
    await report("task", "t1", "user");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(warns.join("")).toMatch(/no connection uuid yet/);
  });

  it("never throws on a network error; logs a warning", async () => {
    const warns = [];
    const report = makeReporter({
      logger: { ...silent, warn: (m) => warns.push(m) },
      fetchImpl: vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    });
    await expect(report("task", "t1", "user")).resolves.toBeUndefined();
    expect(warns.join("")).toMatch(/report-interrupt request failed/);
  });

  it("never throws on a non-2xx; logs the status", async () => {
    const warns = [];
    const report = makeReporter({
      logger: { ...silent, warn: (m) => warns.push(m) },
      fetchImpl: vi.fn(async () => ({ ok: false, status: 404 })),
    });
    await report("task", "t1", "user");
    expect(warns.join("")).toMatch(/returned 404/);
  });

  it("exposes the accepted reason set", () => {
    expect([...INTERRUPT_REASONS].sort()).toEqual(["crash", "user"]);
  });
});
