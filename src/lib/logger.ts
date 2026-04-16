import pino from "pino";
import type { DestinationStream } from "pino";

// Edge Runtime (middleware) uses pino/browser.js which lacks pino.destination
// and cannot require("pino-pretty"). Detect via typeof.
const isEdge = typeof pino.destination !== "function";

function getDevStream(): DestinationStream | undefined {
  const forcePretty = process.env.LOG_PRETTY === "true" || process.env.LOG_PRETTY === "1";
  if (isEdge || (process.env.NODE_ENV === "production" && !forcePretty)) return undefined;
  try {
    // Dynamic require avoids bundling pino-pretty in production.
    // pinoPretty() returns a synchronous Transform stream — no worker thread.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pinoPretty = require("pino-pretty") as (opts: Record<string, unknown>) => DestinationStream;
    return pinoPretty({ colorize: true, translateTime: "HH:MM:ss", ignore: "pid,hostname" });
  } catch {
    return undefined;
  }
}

const devStream = getDevStream();

const loggerOpts = {
  level:
    process.env.LOG_LEVEL ||
    (process.env.NODE_ENV === "production" ? "info" : "debug"),
  base: { service: "chorus" },
};

// In Edge: pino(opts) only. In Node: pino(opts, stream).
const logger = devStream
  ? pino(loggerOpts, devStream)
  : pino(loggerOpts);

export default logger;

export function createRequestLogger(context: {
  requestId: string;
  companyUuid?: string;
}) {
  return logger.child(context);
}
