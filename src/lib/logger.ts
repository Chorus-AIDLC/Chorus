import pino from "pino";

const logger = pino({
  level:
    process.env.LOG_LEVEL ||
    (process.env.NODE_ENV === "production" ? "info" : "debug"),
  ...(process.env.NODE_ENV !== "production"
    ? {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "HH:MM:ss" },
        },
      }
    : {}),
  base: { service: "chorus" },
});

export default logger;

export function createRequestLogger(context: {
  requestId: string;
  companyUuid?: string;
}) {
  return logger.child(context);
}
