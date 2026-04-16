import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import logger from "./logger";

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

// Create adapter
const adapter = new PrismaPg(pool);

const dbLogger = logger.child({ module: "prisma" });

export const prisma =
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

// Route Prisma logs through pino ($on may not exist in test mocks).
// `as never` casts: Prisma 7 types $on() for "query"/"warn"/"error" only when
// the matching `emit: "event"` is declared in the `log` config above, but TS
// can't narrow the union from a runtime-conditional array, so we cast.
if (!globalForPrisma.prisma && typeof prisma.$on === "function") {
  prisma.$on("query" as never, (e: { query: string; duration: number }) => {
    dbLogger.debug({ duration: e.duration }, e.query);
  });
  prisma.$on("warn" as never, (e: { message: string }) => {
    dbLogger.warn(e.message);
  });
  prisma.$on("error" as never, (e: { message: string }) => {
    dbLogger.error(e.message);
  });
}

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
  globalForPrisma.pool = pool;
}
