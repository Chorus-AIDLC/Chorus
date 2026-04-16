import { AsyncLocalStorage } from "node:async_hooks";
import type { Logger } from "pino";
import logger from "./logger";

export interface RequestContext {
  requestId: string;
  companyUuid?: string;
  logger: Logger;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

export function getRequestLogger(): Logger {
  return requestContext.getStore()?.logger ?? logger;
}
