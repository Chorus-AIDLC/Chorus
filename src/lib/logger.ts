import pino from "pino";
import type { DestinationStream } from "pino";

function getDevStream(): DestinationStream | undefined {
  if (process.env.NODE_ENV === "production") return undefined;
  try {
    // Dynamic require avoids bundling pino-pretty in production.
    // pinoPretty() returns a synchronous Transform stream — no worker thread.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pinoPretty = require("pino-pretty") as (opts: Record<string, unknown>) => DestinationStream;
    return pinoPretty({ colorize: true, translateTime: "HH:MM:ss", ignore: "pid,hostname" });
  } catch {
    return undefined; // pino-pretty not installed (production image), fall back to JSON
  }
}

const devStream = getDevStream();

const logger = pino(
  {
    level:
      process.env.LOG_LEVEL ||
      (process.env.NODE_ENV === "production" ? "info" : "debug"),
    base: { service: "chorus" },
  },
  devStream ?? pino.destination(1), // stdout
);

export default logger;

export function createRequestLogger(context: {
  requestId: string;
  companyUuid?: string;
}) {
  return logger.child(context);
}
