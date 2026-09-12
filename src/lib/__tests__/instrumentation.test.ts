/**
 * Tests for src/instrumentation.ts#register() — the Next.js startup hook.
 *
 * The notification-listener module is mocked so importing it does not open
 * Redis / DB connections.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const warnOnInsecureNextAuthSecret = vi.fn();
const listenerLoaded = vi.fn();

vi.mock("@/lib/secret-check", () => ({
  warnOnInsecureNextAuthSecret,
}));

vi.mock("@/services/notification-listener", () => {
  listenerLoaded();
  return {};
});

const originalRuntime = process.env.NEXT_RUNTIME;

function restoreRuntime() {
  if (originalRuntime === undefined) {
    delete process.env.NEXT_RUNTIME;
  } else {
    process.env.NEXT_RUNTIME = originalRuntime;
  }
}

describe("instrumentation.register", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  afterEach(() => {
    restoreRuntime();
  });

  it("warns about insecure secret before loading the notification listener under nodejs runtime", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    const order: string[] = [];
    warnOnInsecureNextAuthSecret.mockImplementation(() => order.push("warn"));
    listenerLoaded.mockImplementation(() => order.push("listener"));

    const { register } = await import("@/instrumentation");
    await register();

    expect(warnOnInsecureNextAuthSecret).toHaveBeenCalledTimes(1);
    expect(listenerLoaded).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["warn", "listener"]);
  });

  it("does nothing under the edge runtime", async () => {
    process.env.NEXT_RUNTIME = "edge";

    const { register } = await import("@/instrumentation");
    await register();

    expect(warnOnInsecureNextAuthSecret).not.toHaveBeenCalled();
    expect(listenerLoaded).not.toHaveBeenCalled();
  });

  it("does nothing when NEXT_RUNTIME is unset", async () => {
    delete process.env.NEXT_RUNTIME;

    const { register } = await import("@/instrumentation");
    await register();

    expect(warnOnInsecureNextAuthSecret).not.toHaveBeenCalled();
    expect(listenerLoaded).not.toHaveBeenCalled();
  });
});
