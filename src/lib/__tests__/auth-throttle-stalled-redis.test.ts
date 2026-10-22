import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createServer, type Server, type Socket } from "net";
import { NextRequest } from "next/server";

// Real ioredis + real rate-limiter-flexible against a TCP peer that completes
// the ready handshake and then stops answering — the "socket alive, Redis
// stuck" case that offline-queue / retry settings do not cover.

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() },
}));
vi.mock("@/lib/logger", () => {
  mockLogger.child.mockReturnValue(mockLogger);
  return { default: mockLogger };
});

let server: Server;
const sockets = new Set<Socket>();
// Rate-limit commands (EVALSHA/EVAL) received, one entry per accepted connection.
let evalsPerConnection: number[] = [];

beforeEach(async () => {
  evalsPerConnection = [];
  server = createServer(socket => {
    sockets.add(socket);
    const connection = evalsPerConnection.push(0) - 1;
    socket.on("data", chunk => {
      // Answer the connection handshake (CLIENT SETINFO / INFO ready check);
      // swallow everything else, so EVALSHA/EVAL never get a reply.
      for (const command of chunk.toString().split(/(?=\*\d+\r\n)/)) {
        const name = command.split("\r\n")[2]?.toLowerCase();
        if (name === "info") {
          const info = "# Server\r\nloading:0\r\n";
          socket.write(`$${info.length}\r\n${info}\r\n`);
        } else if (name === "client" || name === "select") {
          socket.write("+OK\r\n");
        } else if (name === "evalsha" || name === "eval") {
          evalsPerConnection[connection]++;
        }
      }
    });
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  vi.stubEnv("REDIS_URL", `redis://127.0.0.1:${port}`);
  vi.stubEnv("AUTH_TRUST_PROXY", "false");
  vi.resetModules();
});

afterEach(async () => {
  const g = globalThis as { redisGeneral?: { disconnect(): void } };
  g.redisGeneral?.disconnect();
  g.redisGeneral = undefined;
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => server.close(resolve));
  vi.unstubAllEnvs();
});

it("bounds auth latency and keeps limiting when a ready Redis stops replying", async () => {
  const { getRedisGeneral } = await import("../redis");
  const { throttleAuth } = await import("../auth-throttle");
  const client = getRedisGeneral()!;
  await new Promise<void>(resolve => (client.status === "ready" ? resolve() : client.once("ready", () => resolve())));

  const started = Date.now();
  const results = await Promise.all(Array.from({ length: 12 }, () =>
    throttleAuth(new NextRequest("http://localhost/api/auth/local/login"), "login", "tenant:alice")));
  const elapsed = Date.now() - started;

  expect(elapsed).toBeLessThan(2_000);
  expect(results.filter(r => r === null)).toHaveLength(10);
  expect(results.filter(r => r?.status === 429)).toHaveLength(2);
  expect(mockLogger.warn).toHaveBeenCalledWith(
    expect.objectContaining({ action: "login" }),
    expect.stringMatching(/insurance limits/),
  );
}, 10_000);

it("recycles the stalled socket without replaying timed-out commands", async () => {
  const { getRedisGeneral } = await import("../redis");
  const { throttleAuth } = await import("../auth-throttle");
  const client = getRedisGeneral()!;
  await new Promise<void>(resolve => (client.status === "ready" ? resolve() : client.once("ready", () => resolve())));

  await Promise.all(Array.from({ length: 12 }, (_, i) =>
    throttleAuth(new NextRequest("http://localhost/api/auth/local/login"), "login", `tenant:user-${i}`)));
  expect(evalsPerConnection[0]).toBe(12);

  // socketTimeout tears the silent connection down; wait for the replacement to be ready.
  await new Promise<void>(resolve => client.once("ready", () => resolve()));
  await new Promise(resolve => setTimeout(resolve, 200));
  expect(evalsPerConnection.length).toBeGreaterThanOrEqual(2);
  // Callers were already served by the insurance limiter; nothing is resent.
  expect(evalsPerConnection.slice(1).every(n => n === 0)).toBe(true);
}, 10_000);
