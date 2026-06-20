// packages/openclaw-plugin/src/connection-state.ts
// Holds the live DaemonConnection identity for this OpenClaw plugin process —
// the `connectionUuid` the server assigns post-handshake and reports via the
// `connection_registered` SSE data event (see api/events/notifications/route.ts).
//
// WHY A DEDICATED MODULE: the connectionUuid is captured in ONE place (the SSE
// listener, via onConnectionId) but READ in several (the daemon REST client to
// attribute execution-state / turn-advance, and the control handler to do its
// `targetConnectionUuid === my uuid` double-check). Threading it through every
// constructor would couple those modules to the listener's lifecycle; instead
// the listener writes it here and the consumers read it through a stable
// `getConnectionUuid()` accessor — the same accessor shape the shared
// `daemon-rest-client` already expects (`getConnectionUuid?: () => string|null`).
//
// The value is refreshed on every `connection_registered` (so a reconnect that
// registers a NEW DaemonConnection overwrites the stale uuid), and is the single
// source of truth for "which connection am I" across the plugin.
//
// This mirrors the CLI host's `SseListener.connectionUuid` field
// (cli/sse-listener.mjs), lifted into a module so the OpenClaw plugin's separate
// modules can share one identity without a circular import on the listener.

/**
 * A read accessor for the live connection identity. This is the exact shape the
 * shared `daemon-rest-client` (`getConnectionUuid?: () => string|null`) and the
 * control handler consume, so a single `ConnectionState` instance can be passed
 * to both.
 */
export interface ConnectionStateReader {
  /** The connection uuid this stream registered as, or null before handshake. */
  getConnectionUuid: () => string | null;
}

/**
 * Mutable connection identity. One instance per plugin process; the SSE
 * listener's `onConnectionId` writes it, the rest client + control handler read
 * it. Not a singleton export — the entry owns the instance and injects it — so
 * tests can construct an isolated state per case.
 */
export class ConnectionState implements ConnectionStateReader {
  private connectionUuid: string | null = null;

  /** The current connection identity, or null before the first handshake. */
  getConnectionUuid(): string | null {
    return this.connectionUuid;
  }

  /**
   * Record (or refresh) the connection identity. Called from the SSE listener's
   * `onConnectionId` on every `connection_registered` event, so a reconnect that
   * registers a new DaemonConnection overwrites the previous uuid rather than
   * leaving a stale one that could mis-route a control command.
   */
  setConnectionUuid(connectionUuid: string): void {
    this.connectionUuid = connectionUuid;
  }

  /**
   * Forget the connection identity (e.g. on a clean disconnect). After this,
   * `getConnectionUuid()` returns null so the control handler's double-check
   * treats every command as "not ours" until a fresh handshake re-registers.
   */
  clear(): void {
    this.connectionUuid = null;
  }
}
