import pino from "pino";

// Dev:  pino-pretty via transport (Turbopack doesn't webpack-bundle, so it works)
// Prod: JSON to stdout (CloudWatch / ELK ready)
// Edge: pino/browser.js silently ignores the transport option
const isDev = process.env.NODE_ENV !== "production";

const logger = pino({
  level: process.env.LOG_LEVEL || (isDev ? "debug" : "info"),
  base: { service: "chorus" },
  ...(isDev
    ? {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "HH:mm:ss", ignore: "pid,hostname" },
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
