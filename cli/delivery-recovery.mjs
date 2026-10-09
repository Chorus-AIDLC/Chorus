import { deliveryError, deliveryRequest } from "./delivery-request.mjs";

const NOOP_LOGGER = { info() {}, warn() {}, error() {} };

export function createDeliveryRecovery({ router, backfill, getConnectionUuid, logger = NOOP_LOGGER, now = Date.now, random = Math.random, intervalMs = 30_000, requestTimeoutMs = 10_000 }) {
  const pending = new Map();
  let generation = 0;
  let stopped = false;
  let registered = false;
  let timer;
  let controller;
  let running = false;
  let sweepAt = Infinity;

  function schedule() {
    clearTimeout(timer);
    if (stopped || !registered || running) return;
    const due = Math.min(sweepAt, ...[...pending.values()].map(job => job.due));
    if (!Number.isFinite(due)) return;
    timer = setTimeout(() => { void run(); }, Math.max(0, due - now()));
    timer.unref?.();
  }

  function settle(key, job, result) {
    if (pending.get(key) !== job) return;
    if (result?.status !== "retryable") {
      pending.delete(key);
      return;
    }
    job.attempt++;
    const delay = job.attempt <= 3 ? [1_000, 2_000, 4_000][job.attempt - 1] : Math.round(intervalMs * (0.8 + random() * 0.2));
    job.due = now() + delay;
    logger.warn(`[Chorus] delivery recovery connection=${getConnectionUuid()} ${key} attempt=${job.attempt} retry-in=${delay}ms`);
  }

  async function run() {
    if (stopped || !registered || running) return;
    running = true;
    const epoch = generation;
    controller = new AbortController();
    const signal = controller.signal;
    const current = () => !stopped && epoch === generation && !signal.aborted;
    const jobs = [...pending.entries()].filter(([,job]) => job.due <= now());
    const turns = jobs.filter(([,job]) => job.kind === "turn");
    const notifications = jobs.filter(([,job]) => job.kind === "notification");
    const sweep = sweepAt <= now();
    if (sweep) sweepAt = now() + intervalMs;
    try {
      await Promise.all([
        ...notifications.map(async ([key,job]) => {
          let result;
          try {
            result = await deliveryRequest(requestSignal => router.dispatch(job.event, { signal: requestSignal }), { signal, timeoutMs: requestTimeoutMs });
          } catch (error) {
            logger.warn(`[Chorus] notification recovery ${key}: ${deliveryError(error)}`);
            result = { status: "retryable" };
          }
          if (current()) settle(key, job, result);
        }),
        (async () => {
          if (!sweep && !turns.length) return;
          let result;
          try {
            result = await deliveryRequest(requestSignal => backfill.pendingTurnsOnly(undefined, {
              signal: requestSignal,
              shouldDispatch: current,
              turnUuids: turns.map(([,job]) => job.turnUuid),
              sweep,
              recoverableOnly: true,
            }), { signal, timeoutMs: requestTimeoutMs });
          } catch (error) {
            logger.warn(`[Chorus] pending recovery connection=${getConnectionUuid()}: ${deliveryError(error)}`);
            result = { status: "retryable" };
          }
          if (!current()) return;
          for (const [key,job] of turns) settle(key,job,result?.status === "accepted" ? result.outcomes?.[job.turnUuid] : result);
          for (const [turnUuid,outcome] of Object.entries(result?.outcomes ?? {})) {
            if (outcome.status === "retryable" && !pending.has(`turn:${turnUuid}`)) {
              const job = { kind: "turn", turnUuid, attempt: 0, due: now() };
              pending.set(`turn:${turnUuid}`,job);
              settle(`turn:${turnUuid}`,job,outcome);
            }
          }
          if (result?.status === "blocked" && [401,403,404].includes(result.httpStatus)) sweepAt = Infinity;
        })(),
      ]);
    } finally {
      running = false;
      schedule();
    }
  }

  function enqueue(key,job) {
    if (stopped) return Promise.resolve({ status: "blocked" });
    if (!pending.has(key)) pending.set(key,{ ...job, attempt: 0, due: now() });
    if (registered && !running) return run();
    schedule();
    return Promise.resolve();
  }

  return {
    dispatch(event) {
      if (event?.type !== "new_notification" || !event.notificationUuid) return router.dispatch(event);
      return enqueue(`notification:${event.notificationUuid}`, { kind: "notification", event });
    },
    deliver(turnUuid) {
      if (!turnUuid) return this.reconcile();
      return enqueue(`turn:${turnUuid}`,{ kind: "turn", turnUuid });
    },
    register() {
      if (stopped) return;
      const replacing = generation > 0;
      generation++;
      controller?.abort();
      router.invalidate?.();
      registered = Boolean(getConnectionUuid());
      if (replacing) pending.clear();
      sweepAt = now();
      schedule();
    },
    reconcile() {
      if (stopped) return;
      sweepAt = now();
      schedule();
    },
    suspend() {
      if (stopped) return;
      registered = false;
      generation++;
      clearTimeout(timer);
      controller?.abort();
      router.invalidate?.();
    },
    stop() {
      stopped = true;
      generation++;
      clearTimeout(timer);
      controller?.abort();
      pending.clear();
      router.stop?.();
    },
  };
}
