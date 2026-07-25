import { afterEach, describe, expect, it } from "vitest";
import { createServer as createHttpServer } from "node:http";
import { createServer as createTcpServer, connect as connectTcp } from "node:net";
import { once } from "node:events";
import { SseListener } from "../sse-listener.mjs";

const WATCHDOG_MS = 140;
const RECONNECT_MS = 20;
const STALE_MS = 70;
const HEARTBEAT_MS = 15;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs, label) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await delay(5);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

describe("SSE silent-partition recovery", () => {
  const cleanup = [];

  afterEach(async () => {
    await Promise.allSettled(cleanup.splice(0).reverse().map((close) => close()));
  });

  it("recovers through a TCP blackhole and rejects work after ack freshness expires", async () => {
    const state = {
      generation: 0,
      active: null,
      lastSeenAt: 0,
      heartbeatWrites: 0,
      heartbeatAcks: 0,
      pending: [],
      backfillReads: 0,
      turnsCreated: 0,
      firstStreamClosedAt: null,
    };
    const streams = new Set();

    const origin = createHttpServer(async (req, res) => {
      const requestUrl = new URL(req.url, "http://origin.test");
      if (requestUrl.pathname === "/api/events/notifications") {
        const generation = ++state.generation;
        const connectedAt = new Date().toISOString();
        state.active = { connectionUuid: "conn-1", connectedAt };
        state.lastSeenAt = performance.now();
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        res.write(
          `data: ${JSON.stringify({
            type: "connection_registered",
            connectionUuid: "conn-1",
            connectedAt,
          })}\n\n`,
        );
        const heartbeat = setInterval(() => {
          state.heartbeatWrites += 1;
          res.write(": heartbeat\n\n");
        }, HEARTBEAT_MS);
        streams.add(res);
        req.on("close", () => {
          clearInterval(heartbeat);
          streams.delete(res);
          if (generation === 1) state.firstStreamClosedAt = performance.now();
        });
        return;
      }

      if (requestUrl.pathname === "/api/daemon/connection-heartbeat") {
        let body = "";
        for await (const chunk of req) body += chunk;
        const ack = JSON.parse(body);
        if (
          state.active &&
          ack.connectionUuid === state.active.connectionUuid &&
          ack.connectedAt === state.active.connectedAt
        ) {
          state.lastSeenAt = performance.now();
          state.heartbeatAcks += 1;
          res.writeHead(200).end();
        } else {
          res.writeHead(409).end();
        }
        return;
      }

      if (requestUrl.pathname === "/api/daemon/pending-turns") {
        state.backfillReads += 1;
        const notifications = state.pending.splice(0);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ notifications }));
        return;
      }

      if (requestUrl.pathname === "/api/daemon-sessions/session-1/instruction") {
        if (performance.now() - state.lastSeenAt > STALE_MS) {
          res.writeHead(409).end();
        } else {
          state.turnsCreated += 1;
          res.writeHead(201).end();
        }
        return;
      }

      res.writeHead(404).end();
    });
    const originPort = await listen(origin);
    cleanup.push(
      () =>
        new Promise((resolve) => {
          for (const stream of streams) stream.destroy();
          origin.close(resolve);
        }),
    );

    let blackholeFirstStream = false;
    let firstResponseSocket = null;
    let firstResponseBytesAtBlackhole = 0;
    let firstResponseBytes = 0;
    const proxySockets = new Set();
    const proxy = createTcpServer((downstream) => {
      const upstream = connectTcp(originPort, "127.0.0.1");
      proxySockets.add(downstream);
      proxySockets.add(upstream);
      downstream.pipe(upstream);
      const isFirst = firstResponseSocket === null;
      if (isFirst) firstResponseSocket = downstream;
      upstream.on("data", (chunk) => {
        if (isFirst) {
          firstResponseBytes += chunk.byteLength;
          if (blackholeFirstStream) return;
        }
        if (!downstream.destroyed) downstream.write(chunk);
      });
      const closePeer = (socket) => {
        proxySockets.delete(socket);
        if (!socket.destroyed) socket.destroy();
      };
      downstream.on("close", () => closePeer(upstream));
      upstream.on("close", () => closePeer(downstream));
      downstream.on("error", () => {});
      upstream.on("error", () => {});
    });
    const proxyPort = await listen(proxy);
    cleanup.push(
      () =>
        new Promise((resolve) => {
          for (const socket of proxySockets) socket.destroy();
          proxy.close(resolve);
        }),
    );

    const baseUrl = `http://127.0.0.1:${proxyPort}`;
    const received = [];
    const recoveryTimings = {};
    let listener;
    const listenerCleanup = () => listener?.disconnect();
    cleanup.push(async () => listenerCleanup());

    listener = new SseListener({
      url: baseUrl,
      apiKey: "cho_test",
      watchdogTimeoutMs: WATCHDOG_MS,
      initialDelayMs: RECONNECT_MS,
      maxDelayMs: RECONNECT_MS,
      logger: { info() {}, warn() {}, error() {} },
      onEvent: (event) => received.push(event),
      acknowledgeHeartbeat: async (registration) =>
        fetch(`${baseUrl}/api/daemon/connection-heartbeat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(registration),
        }),
      onReconnect: async () => {
        recoveryTimings.reconnectedAt = performance.now();
        const response = await fetch(`${baseUrl}/api/daemon/pending-turns`);
        const body = await response.json();
        received.push(...body.notifications);
      },
    });

    await listener.connect();
    await waitFor(() => state.heartbeatAcks > 0, 500, "initial heartbeat acknowledgment");

    blackholeFirstStream = true;
    firstResponseBytesAtBlackhole = firstResponseBytes;
    const blackholedAt = performance.now();
    const lastSeenAtBlackhole = state.lastSeenAt;
    state.pending.push({ type: "new_notification", notificationUuid: "during-gap" });
    for (const stream of streams) {
      stream.write(
        `data: ${JSON.stringify({
          type: "new_notification",
          notificationUuid: "during-gap",
        })}\n\n`,
      );
    }

    await delay(STALE_MS + 25);
    expect(firstResponseBytes).toBeGreaterThan(firstResponseBytesAtBlackhole);
    expect(state.firstStreamClosedAt).toBeNull();
    expect(received).toEqual([]);
    expect(state.heartbeatWrites).toBeGreaterThan(1);
    expect(state.lastSeenAt).toBe(lastSeenAtBlackhole);

    const instruction = await fetch(
      `${baseUrl}/api/daemon-sessions/session-1/instruction`,
      { method: "POST" },
    );
    expect(instruction.status).toBe(409);
    expect(state.turnsCreated).toBe(0);

    await waitFor(() => state.generation === 2 && state.backfillReads === 1, 700, "watchdog reconnect");
    await waitFor(() => received.length === 1, 300, "notification backfill");
    recoveryTimings.firstStreamClosedAt = state.firstStreamClosedAt;

    expect(state.firstStreamClosedAt).not.toBeNull();
    expect(state.firstStreamClosedAt - blackholedAt).toBeGreaterThanOrEqual(WATCHDOG_MS - 30);
    expect(recoveryTimings.reconnectedAt - blackholedAt).toBeLessThan(WATCHDOG_MS + RECONNECT_MS + 180);
    expect(received).toEqual([
      { type: "new_notification", notificationUuid: "during-gap" },
    ]);
    expect(state.backfillReads).toBe(1);

    // Keep measured bounds visible in verbose CI output without making them assertions-only.
    // eslint-disable-next-line no-console
    console.info(
      `[silent-partition] watchdog abort=${Math.round(
        state.firstStreamClosedAt - blackholedAt,
      )}ms reconnect+backfill=${Math.round(
        recoveryTimings.reconnectedAt - blackholedAt,
      )}ms`,
    );
  }, 3_000);
});
