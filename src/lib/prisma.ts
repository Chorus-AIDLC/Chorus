import { PrismaClient, Prisma } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import logger from "./logger";

export type TransactionClient = Prisma.TransactionClient;

// Use DATABASE_URL if set, otherwise build from individual env vars (ECS Secrets Manager)
const connectionString =
  process.env.DATABASE_URL ||
  (process.env.DB_HOST
    ? `postgresql://${process.env.DB_USERNAME}:${encodeURIComponent(process.env.DB_PASSWORD || "")}@${process.env.DB_HOST}:${process.env.DB_PORT || "5432"}/${process.env.DB_NAME || "chorus"}`
    : undefined);

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
  pool: pg.Pool | undefined;
};

// Create connection pool (ssl required for Aurora PostgreSQL)
const pool =
  globalForPrisma.pool ??
  new pg.Pool({
    connectionString,
    ...(process.env.DB_HOST ? { ssl: { rejectUnauthorized: false } } : {}),
  });

// Silently evict broken connections instead of crashing the process
if (!globalForPrisma.pool) {
  pool.on("error", (err: Error) => {
    logger
      .child({ module: "pg-pool" })
      .warn({ err: err.message }, "Idle connection evicted");
  });
}

// Create adapter
const adapter = new PrismaPg(pool);

const dbLogger = logger.child({ module: "prisma" });

const basePrisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter,
    log:
      process.env.NODE_ENV === "development"
        ? [
            { emit: "event", level: "query" },
            { emit: "event", level: "warn" },
            { emit: "event", level: "error" },
          ]
        : [{ emit: "event", level: "error" }],
  });

// Auto-retry on stale/dropped connections.
// PGlite silently drops idle connections; pg.Pool doesn't detect this until
// a query fails with P1017 or "Connection terminated unexpectedly".
// Each failed attempt evicts one bad connection from the pool.
const STALE_CONN_MAX_RETRIES = 3;
const poolLogger = logger.child({ module: "pg-pool" });

function isStaleConnectionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if ("code" in err && (err as { code: string }).code === "P1017") return true;
  if (err.message.includes("Connection terminated")) return true;
  if (err.message.includes("Server has closed the connection")) return true;
  return false;
}

export const prisma = basePrisma.$extends({
  query: {
    async $allOperations({ args, query }) {
      let lastErr: unknown;
      for (let attempt = 0; attempt <= STALE_CONN_MAX_RETRIES; attempt++) {
        try {
          return await query(args);
        } catch (err: unknown) {
          if (isStaleConnectionError(err) && attempt < STALE_CONN_MAX_RETRIES) {
            poolLogger.warn("Stale connection evicted (attempt %d/%d)", attempt + 1, STALE_CONN_MAX_RETRIES);
            lastErr = err;
            continue;
          }
          throw err;
        }
      }
      throw lastErr;
    },
  },
});

// Route Prisma logs through pino ($on may not exist in test mocks).
// $on lives on the base PrismaClient, not on the extended client.
if (!globalForPrisma.prisma && typeof basePrisma.$on === "function") {
  basePrisma.$on("query" as never, (e: { query: string; duration: number }) => {
    dbLogger.debug({ duration: e.duration }, e.query);
  });
  basePrisma.$on("warn" as never, (e: { message: string }) => {
    dbLogger.warn(e.message);
  });
  basePrisma.$on("error" as never, (e: { message: string }) => {
    dbLogger.error(e.message);
  });
}

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = basePrisma;
  globalForPrisma.pool = pool;
}
