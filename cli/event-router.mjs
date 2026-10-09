import { randomUUID } from "node:crypto";
import { OPERATION_ACTIONS, validateOperation } from "./operation.mjs";

const NOOP_LOGGER = { info() {}, warn() {}, error() {} };
const ACTION_TO_TURN_TRIGGER = {
  mentioned: "mentioned", elaboration_verified: "elaboration_verified",
  start_development: "start_development", yolo_requested: "yolo_requested",
  elaboration_requested: "elaboration", elaboration_answered: "elaboration",
  human_instruction: "human_instruction", task_assigned: "task_assigned",
  idea_creation_requested: "idea_creation_requested", research_requested: "research_requested",
  task_reopened: "task_assigned", task_verified: "task_assigned", idea_claimed: "task_assigned",
  proposal_approved: "task_assigned", proposal_rejected: "task_assigned",
};
const nonempty = (value) => typeof value === "string" && value.length > 0;

export class EventRouter {
  constructor(opts) {
    this.mcp = opts.mcpClient;
    this.waker = opts.waker;
    this.queue = opts.queue;
    this.wakeActions = opts.wakeActions;
    this.getConnectionUuid = opts.getConnectionUuid ?? (() => null);
    this.logger = opts.logger ?? NOOP_LOGGER;
    this.seen = opts.seen ?? new Set();
    this.acceptedAliases = new Map();
    this.acceptedAdmissions = new Map();
    this.rejectedAdmissions = new Map();
    this.inFlight = new Map();
    this.generation = 0;
    this.stopped = false;
    this.pendingDispatchCount = 0;
    this.pendingDispatch = Promise.resolve();
  }

  invalidate() {
    this.generation++;
    this.inFlight.clear();
  }

  stop() {
    this.stopped = true;
    this.invalidate();
  }

  releaseAccepted(turnUuids, deliveryAdmissions) {
    for (const turnUuid of turnUuids) {
      const key = `turn:${turnUuid}`;
      if (deliveryAdmissions && this.acceptedAdmissions.get(key) !== deliveryAdmissions[turnUuid]) continue;
      for (const alias of this.acceptedAliases.get(key) ?? [key]) this.seen.delete(alias);
      this.acceptedAliases.delete(key);
      this.acceptedAdmissions.delete(key);
    }
  }

  rejectAdmission(report) {
    if (report.connectionUuid !== undefined && report.connectionUuid !== this.getConnectionUuid()) return;
    this.rejectedAdmissions.set(report.admissionUuid, report);
  }

  reconcilePendingTurns(turns) {
    const pending = new Set(turns.filter((turn) => nonempty(turn?.turnUuid)).map((turn) => turn.turnUuid));
    for (const [admissionUuid, report] of this.rejectedAdmissions) {
      if (report.connectionUuid !== undefined && report.connectionUuid !== this.getConnectionUuid()) {
        this.rejectedAdmissions.delete(admissionUuid);
        continue;
      }
      const survivors = report.turnUuids.filter((turnUuid) => pending.has(turnUuid));
      if (survivors.length === report.turnUuids.length) continue;
      this.releaseAccepted(survivors, report.deliveryAdmissions);
      this.rejectedAdmissions.delete(admissionUuid);
    }
  }

  #accept(keys) {
    for (const key of keys) {
      this.seen.add(key);
      if (key.startsWith("turn:")) this.acceptedAliases.set(key, [...new Set([...(this.acceptedAliases.get(key) ?? []), ...keys])]);
    }
  }

  #scope(signal) {
    return { signal, generation: this.generation, connectionUuid: this.getConnectionUuid() };
  }

  #guard(scope, transport = {}) {
    if (this.stopped) return { status: "ignored", reason: "stopped" };
    if (scope.signal?.aborted) return { status: "retryable", reason: "aborted" };
    if (scope.generation !== this.generation || scope.connectionUuid !== this.getConnectionUuid()) {
      return { status: "retryable", reason: "connection_changed" };
    }
    if (transport.suppressWake === true) {
      this.logger.info("[Chorus] OFFLINE-PIN — notify-only, suppressing wake");
      return { status: "ignored", reason: "suppressed" };
    }
    if (nonempty(transport.targetConnectionUuid) && transport.targetConnectionUuid !== scope.connectionUuid) {
      this.logger.info(`[Chorus] directed to connection ${transport.targetConnectionUuid} — not this daemon; suppressing wake`);
      return { status: "ignored", reason: "different_target" };
    }
    return null;
  }

  #context(source) {
    const context = source.wakeContext;
    const notification = context?.notification;
    if (context?.version !== 1 || !nonempty(context.notificationUuid) ||
        !nonempty(source.turnUuid) || !notification ||
        !nonempty(notification.action) || !nonempty(notification.entityType) ||
        !nonempty(notification.entityUuid) ||
        notification.uuid !== context.notificationUuid ||
        (source.notificationUuid != null && source.notificationUuid !== context.notificationUuid) ||
        (source.trigger != null && ACTION_TO_TURN_TRIGGER[notification.action] !== source.trigger)) return null;
    return { ...notification, uuid: context.notificationUuid, turnUuid: source.turnUuid, wakeRecoveryProtocol: 1 };
  }

  #failure(error, label) {
    const status = error?.status ?? error?.statusCode;
    const retryable = !status || status === 408 || status === 429 || status >= 500;
    const code = error?.cause?.code ?? error?.code;
    const safeCode = typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code) ? code : "unknown";
    this.logger.warn(`[Chorus] failed to route ${label}: status=${Number(status) || "unknown"} cause=${safeCode}`);
    return { status: retryable ? "retryable" : "blocked", reason: "routing_failed" };
  }

  #track(keys, scope, transport, work) {
    const guard = this.#guard(scope, transport);
    if (guard) return Promise.resolve(guard);
    if (keys.some((key) => this.seen.has(key))) {
      this.#accept(keys);
      return Promise.resolve({ status: "duplicate" });
    }
    const existing = keys.map((key) => this.inFlight.get(key)).find(Boolean);
    if (existing) return this.#abortable(existing, scope.signal).then((result) => {
      const invalid = this.#guard(scope, transport);
      if (invalid) return invalid;
      if (result.status === "accepted" || result.status === "duplicate") {
        this.#accept(keys);
        return { status: "duplicate" };
      }
      return result;
    });
    let settle;
    const pending = new Promise((resolve) => { settle = resolve; });
    for (const key of keys) this.inFlight.set(key, pending);
    const finish = (result) => {
      if (result.status === "accepted") this.#accept(keys);
      for (const key of keys) if (this.inFlight.get(key) === pending) this.inFlight.delete(key);
      settle(result);
    };
    try {
      const result = work();
      if (result?.then) this.#abortable(result, scope.signal)
        .then(finish, (error) => finish(this.#failure(error, keys.join(","))));
      else finish(result);
    } catch (error) {
      finish(this.#failure(error, keys.join(",")));
    }
    return pending;
  }

  #abortable(pending, signal) {
    if (!signal) return Promise.resolve(pending);
    if (signal.aborted) return Promise.resolve({ status: "retryable", reason: "aborted" });
    return new Promise((resolve, reject) => {
      const abort = () => resolve({ status: "retryable", reason: "aborted" });
      signal.addEventListener("abort", abort, { once: true });
      Promise.resolve(pending).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  }

  dispatch(event, { signal } = {}) {
    if (event?.type !== "new_notification") return Promise.resolve({ status: "ignored", reason: "event_type" });
    if (!nonempty(event.notificationUuid)) return Promise.resolve({ status: "blocked", reason: "missing_notification" });
    if (event.wakeRecoveryProtocol != null && event.wakeRecoveryProtocol !== 1) {
      return Promise.resolve({ status: "blocked", reason: "unsupported_wake_protocol" });
    }
    const scope = this.#scope(signal);
    const notification = event.wakeContext != null ? this.#context(event) : null;
    if ((event.wakeContext != null || event.wakeRecoveryProtocol === 1) && !notification) {
      return Promise.resolve({ status: "blocked", reason: "invalid_wake_context" });
    }
    const keys = [event.notificationUuid, ...(notification ? [`turn:${event.turnUuid}`] : [])];
    return this.#track(keys, scope, event, async () => {
      let detail = notification;
      if (!detail) {
        const result = await this.mcp.callTool("chorus_get_notifications", {
          status: "all", limit: 50, autoMarkRead: false,
        });
        const invalid = this.#guard(scope, event);
        if (invalid) return invalid;
        if (!Array.isArray(result?.notifications)) return { status: "retryable", reason: "notification_read_failed" };
        detail = result.notifications.find((candidate) => candidate?.uuid === event.notificationUuid);
        if (!detail) return { status: "blocked", reason: "notification_unavailable" };
      }
      if (detail.action === "human_instruction" || OPERATION_ACTIONS.has(detail.action)) {
        this.logger.info(`[Chorus] ${detail.action} is delivered via deliver_turn / pending-turn backfill — ignoring notification`);
        return { status: "ignored", reason: "turn_delivery_only" };
      }
      if (!this.wakeActions.has(detail.action)) return { status: "ignored", reason: "not_wake_action" };
      return this.#resolveAndEnqueue({ ...detail, ...this.#transport(event) }, scope, event);
    });
  }

  #transport(source) {
    return {
      ...(typeof source.runtimeCwd === "string" ? { runtimeCwd: source.runtimeCwd } : {}),
      ...(typeof source.targetConnectionUuid === "string" ? { targetConnectionUuid: source.targetConnectionUuid } : {}),
      ...(source.suppressWake === true ? { suppressWake: true } : {}),
    };
  }

  dispatchResume(target, { signal } = {}) {
    if (!nonempty(target?.entityType) || !nonempty(target?.entityUuid)) {
      return Promise.resolve({ status: "blocked", reason: "invalid_resume" });
    }
    const notification = {
      action: "resource_resumed", entityType: target.entityType, entityUuid: target.entityUuid,
      ...this.#transport(target),
      ...(["user", "crash"].includes(target.resumeReason) ? { resumedFrom: target.resumeReason } : {}),
      ...(target.orchestrator?.type === "agent" && nonempty(target.orchestrator.uuid) && nonempty(target.orchestrator.name)
        ? { orchestrator: target.orchestrator } : {}),
    };
    const scope = this.#scope(signal);
    return this.#track([], scope, target, () => this.#resolveAndEnqueue(notification, scope, target));
  }

  dispatchPendingTurn(pending, { signal } = {}) {
    const scope = this.#scope(signal);
    if (OPERATION_ACTIONS.has(pending?.trigger) || this.pendingDispatchCount > 0) {
      this.pendingDispatchCount++;
      this.pendingDispatch = this.pendingDispatch
        .then(() => this.#dispatchPendingTurnNow(pending, scope))
        .finally(() => { this.pendingDispatchCount--; });
      return this.#abortable(this.pendingDispatch, signal);
    }
    return this.#dispatchPendingTurnNow(pending, scope);
  }

  #dispatchPendingTurnNow(pending, scope) {
    if (!nonempty(pending?.turnUuid) || !nonempty(pending?.sessionId)) {
      this.logger.warn("[Chorus] pending-turn dispatch missing turnUuid/sessionId, skipping");
      return Promise.resolve({ status: "blocked", reason: "missing_turn_identity" });
    }
    if (pending.wakeRecoveryProtocol != null && pending.wakeRecoveryProtocol !== 1) {
      return Promise.resolve({ status: "blocked", reason: "unsupported_wake_protocol" });
    }
    const notification = pending.wakeContext != null ? this.#context(pending) : null;
    if (pending.wakeContext != null && !notification) {
      return Promise.resolve({ status: "blocked", reason: "invalid_wake_context" });
    }
    const keys = [`turn:${pending.turnUuid}`, ...(notification ? [notification.uuid] : [])];
    return this.#track(keys, scope, pending, () => {
      if (OPERATION_ACTIONS.has(pending.trigger)) return this.#dispatchOperation(pending, scope);
      if (pending.trigger === "human_instruction") {
        const instruction = typeof pending.promptText === "string" ? pending.promptText.trim() : "";
        if (!instruction) {
          this.logger.warn(`[Chorus] pending human_instruction turn ${pending.turnUuid} has no promptText — skipping`);
          return { status: "blocked", reason: "missing_prompt" };
        }
        const directIdeaUuid = pending.directIdeaUuid ?? null;
        const detail = {
          action: "human_instruction", turnUuid: pending.turnUuid, wakeRecoveryProtocol: 1,
          sessionId: pending.sessionId,
          entityType: directIdeaUuid ? "idea" : "daemon_session",
          entityUuid: directIdeaUuid ?? pending.sessionId, instructionText: instruction,
          ...(instruction.startsWith("[Chorus Tracker Research]") ? { researchOnly: true } : {}),
          ...this.#transport(pending),
        };
        const key = directIdeaUuid ? `idea:${directIdeaUuid}` : `entity:daemon_session:${pending.sessionId}`;
        return this.#enqueue(detail, { key, rootIdeaUuid: directIdeaUuid, directIdeaUuid }, scope, pending, detail.researchOnly);
      }
      if (!notification) {
        this.logger.warn(`[Chorus] autonomous pending turn ${pending.turnUuid}: missing exact wake context; legacy recovery blocked`);
        return { status: "blocked", reason: "missing_wake_context" };
      }
      if (!this.wakeActions.has(notification.action)) return { status: "ignored", reason: "not_wake_action" };
      return this.#resolveAndEnqueue({ ...notification, sessionId: pending.sessionId, ...this.#transport(pending) }, scope, pending);
    });
  }

  async #dispatchOperation(pending, scope) {
    let payload;
    try {
      payload = { ...validateOperation(pending.trigger, pending.operationPayload, pending) };
    } catch {
      this.logger.warn(`[Chorus] operation turn ${pending.turnUuid} remains pending and retryable after correction: operation protocol error`);
      return { status: "blocked", reason: "invalid_operation" };
    }
    if (payload.kind === "idea_creation") {
      const idea = await this.mcp.callTool("chorus_get_idea", { ideaUuid: pending.directIdeaUuid });
      if (idea?.uuid !== pending.directIdeaUuid || idea?.project?.uuid !== payload.projectUuid) {
        this.logger.warn(`[Chorus] operation turn ${pending.turnUuid} remains pending and retryable after correction: operation protocol error (project mismatch)`);
        return { status: "blocked", reason: "operation_project_mismatch" };
      }
    }
    const notification = {
      action: pending.trigger, turnUuid: pending.turnUuid,
      sessionId: pending.sessionId, directIdeaUuid: pending.directIdeaUuid,
      entityType: "idea", entityUuid: pending.directIdeaUuid,
      operationPayload: payload, promptText: pending.promptText,
      ...(payload.kind === "idea_creation" ? { projectUuid: payload.projectUuid } : {}),
      ...this.#transport(pending),
    };
    const key = `idea:${pending.directIdeaUuid}`;
    return this.#enqueue(notification, { key, rootIdeaUuid: pending.directIdeaUuid, directIdeaUuid: pending.directIdeaUuid }, scope, pending, true);
  }

  async #resolveAndEnqueue(notification, scope, transport) {
    const invalid = this.#guard(scope, transport);
    if (invalid) return invalid;
    const attribution = await this.waker.keyFor(notification);
    return this.#enqueue(notification, attribution, scope, transport);
  }

  #enqueue(notification, attribution, scope, transport, isolated = false) {
    const invalid = this.#guard(scope, transport);
    if (invalid) return invalid;
    if (notification.turnUuid) notification.admissionUuid = randomUUID();
    const accepted = this.queue.enqueue(attribution.key, { notification, attribution, ...(isolated ? { isolated: true } : {}) });
    if (accepted === false) return { status: "retryable", reason: "queue_refused" };
    if (notification.turnUuid) this.acceptedAdmissions.set(`turn:${notification.turnUuid}`, notification.admissionUuid);
    if (notification.uuid) this.seen.add(notification.uuid);
    if (notification.turnUuid) this.seen.add(`turn:${notification.turnUuid}`);
    try {
      this.waker.markQueued?.(notification, attribution.key, attribution);
    } catch {
      this.logger.warn(`[Chorus] markQueued failed for ${notification.turnUuid ?? notification.uuid}`);
    }
    return { status: "accepted" };
  }
}
