type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const minLevel: LogLevel =
  (process.env.NEXT_PUBLIC_LOG_LEVEL as LogLevel) ||
  (process.env.NODE_ENV === "production" ? "warn" : "debug");

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[minLevel];
}

export const clientLogger = {
  /* eslint-disable no-console */
  debug: (msg: string, ...args: unknown[]) => {
    if (shouldLog("debug")) console.debug(`[Chorus] ${msg}`, ...args);
  },
  info: (msg: string, ...args: unknown[]) => {
    if (shouldLog("info")) console.info(`[Chorus] ${msg}`, ...args);
  },
  warn: (msg: string, ...args: unknown[]) => {
    if (shouldLog("warn")) console.warn(`[Chorus] ${msg}`, ...args);
  },
  error: (msg: string, ...args: unknown[]) => {
    if (shouldLog("error")) console.error(`[Chorus] ${msg}`, ...args);
  },
  /* eslint-enable no-console */
};
