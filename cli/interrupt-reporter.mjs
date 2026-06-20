// cli/interrupt-reporter.mjs
// Reports a wake's `interrupted` outcome (reason = "user" | "crash") back to the
// Chorus server (子3 — daemon-interrupt-resume). The waker calls this after a
// wake's subprocess exits:
//   • interrupt-initiated exit (the control handler set the "interrupting" flag)
//       → reason = "user"
//   • unexpected non-zero exit with NO interrupt flag → reason = "crash"
//   • clean exit (code 0) → nothing is reported (unchanged behavior).
//
// The outcome is recorded on the server's EXECUTION row (keyed connection + entity),
// NOT on the Task model — the daemon executes task / idea / proposal / document
// wakes, so the interrupted state is entity-generic. This module therefore reports
// for ANY recognized entity kind (not just tasks) and carries the daemon's own
// `connectionUuid` so the server can target the right execution row.
//
// Transport: the SHARED daemon REST client (`cli/daemon-rest-client.mjs`) owns the actual
// `POST /api/daemon/report-interrupt` request, its Bearer auth, and the no-silent-errors
// transport contract — this module is the thin domain wrapper that validates the
// entity/reason and maps the call into the client's `reportInterrupt` payload. It adds NO
// new npm dependency (CLAUDE.md pitfall #9) and no shell-out. It is fire-and-forget and
// NEVER throws into the wake path: a failure is LOGGED by the shared client (memory:
// no-silent-errors) and the returned result is swallowed.

import { createDaemonRestClient } from "./daemon-rest-client.mjs";

const NOOP_LOGGER = { info() {}, warn() {}, error() {} };

/** Interrupt reason values the server's report-interrupt endpoint accepts. */
export const INTERRUPT_REASONS = new Set(["user", "crash"]);

/** Entity kinds the server's DaemonExecution (and report-interrupt) accept. Includes
 *  `daemon_session` — an ad-hoc conversation is its own execution entity, so its
 *  interrupted/resumable state must be reportable too (else ad-hoc Interrupt→Resume is
 *  broken: the row would never go sticky `interrupted`+`user` and Resume could never
 *  fire). Mirrors the server's CONTROL_ENTITY_TYPES. */
const REPORTABLE_ENTITY_TYPES = new Set([
  "task",
  "idea",
  "proposal",
  "document",
  "daemon_session",
]);

/**
 * Build a `reportInterrupt(entityType, entityUuid, reason)` function the waker
 * invokes when a wake's subprocess exits in an interrupted/crashed state.
 *
 * @param {{
 *   url: string,                          Chorus base URL.
 *   apiKey: string,                       `cho_` agent API key.
 *   getConnectionUuid: () => string|null, The daemon's registered connection uuid
 *                                         (learned from the SSE handshake). The
 *                                         server targets the execution row by
 *                                         connection + entity, so this is required;
 *                                         a null/absent value skips the report.
 *   logger?: { info(m:string):void, warn(m:string):void, error(m:string):void },
 *   fetchImpl?: typeof fetch,             Injectable for tests.
 * }} opts
 * @returns {(entityType: string, entityUuid: string, reason: "user"|"crash") => Promise<void>}
 */
export function createInterruptReporter(opts) {
  const logger = opts.logger ?? NOOP_LOGGER;
  // The shared client owns the request, Bearer auth, the connectionUuid guard, and the
  // surface-not-swallow transport contract. This wrapper keeps only the interrupt-domain
  // validation (entity kind / reason) that is NOT the client's concern.
  const client = createDaemonRestClient({
    url: opts.url,
    apiKey: opts.apiKey,
    getConnectionUuid: opts.getConnectionUuid ?? (() => null),
    fetchImpl: opts.fetchImpl,
    logger,
  });

  return async function reportInterrupt(entityType, entityUuid, reason) {
    if (!REPORTABLE_ENTITY_TYPES.has(entityType) || !entityUuid || !INTERRUPT_REASONS.has(reason)) {
      logger.warn(
        `[Chorus] refusing to report interrupt: bad entity/reason (${entityType}:${entityUuid}, ${reason})`,
      );
      return;
    }
    // The client resolves the connectionUuid lazily, validates it (logging
    // "no connection uuid yet" when absent), POSTs the exact server payload, and logs the
    // failure cause on a network error / non-2xx. We swallow the structured result so a
    // failed report can never crash the wake path.
    await client.reportInterrupt({ entityType, entityUuid, reason });
  };
}
