import pino from "pino";

// NOTE: Do NOT use pino's `transport` option here — it spawns a worker thread
// via thread-stream, which Next.js webpack cannot resolve. For pretty output in
// dev, pipe through pino-pretty: `pnpm dev | pnpm exec pino-pretty`
const logger = pino({
  level:
    process.env.LOG_LEVEL ||
    (process.env.NODE_ENV === "production" ? "info" : "debug"),
  base: { service: "chorus" },
});

export default logger;

export function createRequestLogger(context: {
  requestId: string;
  companyUuid?: string;
}) {
  return logger.child(context);
}
