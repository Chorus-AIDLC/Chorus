import pino from "pino";

// This module is imported by both Node.js server code AND Edge Runtime
// (middleware). pino and pino-pretty are in serverExternalPackages so webpack
// does not bundle them — they are loaded from node_modules at runtime.
//
// In Edge Runtime, pino resolves to pino/browser.js which ignores the
// transport option silently, so the same code works in both environments.
const forcePretty = process.env.LOG_PRETTY === "true" || process.env.LOG_PRETTY === "1";
const usePretty = forcePretty || process.env.NODE_ENV !== "production";

const logger = pino({
  level:
    process.env.LOG_LEVEL ||
    (process.env.NODE_ENV === "production" ? "info" : "debug"),
  base: { service: "chorus" },
  ...(usePretty
    ? {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "HH:MM:ss", ignore: "pid,hostname" },
        },
      }
    : {}),
});

export default logger;

export function createRequestLogger(context: {
  requestId: string;
  companyUuid?: string;
}) {
  return logger.child(context);
}
