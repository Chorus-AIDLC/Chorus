import { describe, it, expect } from "vitest";
import { ConnectionState } from "../connection-state.js";

describe("ConnectionState", () => {
  it("starts unregistered (null) before any connection_registered", () => {
    const state = new ConnectionState();
    expect(state.getConnectionUuid()).toBeNull();
  });

  it("captures the connectionUuid set from connection_registered", () => {
    const state = new ConnectionState();
    state.setConnectionUuid("conn-1");
    expect(state.getConnectionUuid()).toBe("conn-1");
  });

  it("refreshes the connectionUuid on reconnect (overwrites the stale one)", () => {
    const state = new ConnectionState();
    state.setConnectionUuid("conn-old");
    expect(state.getConnectionUuid()).toBe("conn-old");
    // A reconnect registers a NEW DaemonConnection — the stale uuid must not linger.
    state.setConnectionUuid("conn-new");
    expect(state.getConnectionUuid()).toBe("conn-new");
  });

  it("clear() forgets the identity (back to null)", () => {
    const state = new ConnectionState();
    state.setConnectionUuid("conn-1");
    state.clear();
    expect(state.getConnectionUuid()).toBeNull();
  });

  it("exposes a getConnectionUuid accessor shaped for the rest client + control handler", () => {
    const state = new ConnectionState();
    state.setConnectionUuid("conn-x");
    // The accessor is the exact `() => string | null` shape both consumers read.
    const read: () => string | null = state.getConnectionUuid.bind(state);
    expect(read()).toBe("conn-x");
  });
});
