import type { NextRequest } from "next/server";
import { getAuthContext } from "@/lib/auth";
import { eventBus } from "@/lib/event-bus";
import { streamCredential, validateStreamCredential } from "@/lib/stream-credentials";
import type { AgentAuthContext, AuthContext } from "@/types/auth";
import type { AccountAccessChangedEvent } from "@/lib/account-access-events";

export const SSE_AUTH_LEASE_MS = 30_000;
const RENEW_EARLY_MS = 5_000;

/** Event-driven revocation with a bounded lease. Normal messages only check
 * memory and deadlines; indexed state reads renew the lease ahead of heartbeat.
 * Redis is best-effort: even a missed broadcast cannot extend stale delivery
 * beyond 30 seconds. Deadline is measured from query START, not completion. */
export function createSseAuthGate(
  request: NextRequest,
  initial: AuthContext,
  controller: ReadableStreamDefaultController<Uint8Array>,
  cleanup: () => void,
) {
  const encoder = new TextEncoder();
  const credential = streamCredential(initial);
  let closed = false;
  let revision = 0;
  let validatedRevision = -1;
  let deadline = performance.now() + SSE_AUTH_LEASE_MS;
  let chain = Promise.resolve();
  let checking: Promise<void> | undefined;
  let renewal: ReturnType<typeof setTimeout> | undefined;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(renewal);
    clearTimeout(expiry);
    eventBus.off("account_access_changed", changed);
    request.signal.removeEventListener("abort", close);
    cleanup();
    try { controller.close(); } catch { /* Already cancelled/closed. */ }
  };
  const expired = () => performance.now() >= deadline ||
    (credential?.expiresAt !== undefined && Date.now() >= credential.expiresAt);
  const schedule = () => {
    clearTimeout(renewal);
    clearTimeout(expiry);
    const remaining = Math.min(deadline - performance.now(), credential?.expiresAt === undefined ? Infinity : credential.expiresAt - Date.now());
    expiry = setTimeout(close, Math.max(0, remaining));
    const renewAfter = Math.max(0, deadline - performance.now() - RENEW_EARLY_MS);
    if (renewAfter < remaining) renewal = setTimeout(() => { void refresh(); }, renewAfter);
  };
  const refresh = (): Promise<void> => {
    if (closed) return Promise.resolve();
    if (request.signal.aborted) {
      // Initial route setup must finish defining its teardown callback first.
      // Sends already reject an aborted signal, so deferral cannot deliver data.
      queueMicrotask(close);
      return Promise.resolve();
    }
    if (checking) return checking;
    checking = (async () => {
      for (let attempt = 0; attempt < 3 && !closed; attempt++) {
        const version = revision;
        const started = performance.now();
        let valid: boolean;
        if (credential) valid = await validateStreamCredential(initial, credential);
        else {
          // Compatibility for auth providers without a captured credential. This
          // is still event/time driven and explicitly suppresses usage writes.
          const current = await getAuthContext(request, { trackUsage: false });
          valid = !!current && current.type === initial.type && current.companyUuid === initial.companyUuid && current.actorUuid === initial.actorUuid &&
            (initial.type !== "agent" || (current.ownerUuid === initial.ownerUuid &&
              (initial as AgentAuthContext).permissions.every(permission => (current as AgentAuthContext).permissions.includes(permission))));
        }
        if (closed || request.signal.aborted) return;
        if (version !== revision) continue;
        if (!valid || started + SSE_AUTH_LEASE_MS <= performance.now()) { close(); return; }
        deadline = started + SSE_AUTH_LEASE_MS;
        validatedRevision = version;
        schedule();
        return;
      }
      if (!closed) close();
    })().catch(close).finally(() => {
      checking = undefined;
      // An invalidation can land after the successful read but before this
      // finalizer. Keep its waiters blocked until that revision is checked too.
      if (!closed && validatedRevision !== revision) return refresh();
    });
    return checking;
  };
  const changed = (event: AccountAccessChangedEvent) => {
    if (event.companyUuid !== initial.companyUuid) return;
    if (!(event.userUuid && (event.userUuid === initial.actorUuid || event.userUuid === initial.ownerUuid)) &&
        event.agentUuid !== initial.actorUuid && !(event.keyUuid && credential?.kind === "key" && event.keyUuid === credential.keyUuid)) return;
    revision++;
    void refresh();
  };
  // Register BEFORE the authoritative refresh: catch changes during route setup,
  // plus changes racing this first query (revision forces a second read).
  eventBus.on("account_access_changed", changed);
  request.signal.addEventListener("abort", close);
  schedule();
  void refresh();

  const deliver = (data: string, afterSend?: () => void, allowed: () => boolean = () => true) => {
    chain = chain.then(async () => {
      if (closed || request.signal.aborted) return;
      if (expired()) { close(); return; }
      while (!closed && (checking || validatedRevision !== revision)) await refresh();
      if (closed || request.signal.aborted) return;
      if (expired()) { close(); return; }
      if (!allowed()) return;
      controller.enqueue(encoder.encode(data));
      afterSend?.();
    }).catch(close);
    return chain;
  };
  return { send: deliver, close, get closed() { return closed; } };
}
