// src/lib/event-bus.ts
// Dual-layer event bus: local EventEmitter + optional Redis Pub/Sub
// Local emit for same-process delivery, Redis for cross-instance delivery.
import { EventEmitter } from "events";
import { randomUUID } from "crypto";
import { isRedisEnabled, getRedisPublisher, getRedisSubscriber } from "./redis";
import logger from "@/lib/logger";

const ebLogger = logger.child({ module: "event-bus" });

export interface RealtimeEvent {
  companyUuid: string;
  projectUuid: string;
  entityType: "task" | "idea" | "proposal" | "document" | "project" | "project_group";
  entityUuid: string;
  action: "created" | "updated" | "deleted";
  actorUuid?: string;
}

export interface PresenceEvent {
  companyUuid: string;
  projectUuid: string;
  entityType: "task" | "idea" | "proposal" | "document";
  entityUuid: string;
  /** Optional sub-entity for nested resources (e.g., draft within a proposal) */
  subEntityType?: string;
  subEntityUuid?: string;
  agentUuid: string;
  agentName: string;
  action: "view" | "mutate";
  timestamp: number;
}

// Single Redis channel for all events (ElastiCache Serverless doesn't support PSUBSCRIBE)
const REDIS_CHANNEL = "chorus:events";

/** Envelope wrapping event data with origin ID for dedup + channel for local dispatch */
interface RedisEnvelope {
  _origin: string;
  channel: string;
  data: unknown;
}

class ChorusEventBus extends EventEmitter {
  private _connected = false;
  /** Unique per-process ID to deduplicate own messages from Redis */
  private readonly _instanceId = randomUUID();
  /** Throttle map: key → last emit timestamp (ms) */
  private readonly _presenceThrottle = new Map<string, number>();
  private _evictionTimer: ReturnType<typeof setInterval> | null = null;
  private static readonly THROTTLE_WINDOW_MS = 2000;
  private static readonly EVICTION_INTERVAL_MS = 30000;
  private static readonly EVICTION_TTL_MS = 30000;

  /** Call once at startup to initialize Redis subscriptions */
  async connect(): Promise<void> {
    if (this._connected || !isRedisEnabled()) return;
    this._connected = true;

    const sub = getRedisSubscriber();
    const pub = getRedisPublisher();
    if (!sub) return;

    await sub.connect();
    // Connect publisher eagerly so pub.status === "ready" when emit() checks it
    if (pub) await pub.connect();
    // Use SUBSCRIBE (not PSUBSCRIBE) — compatible with ElastiCache Serverless
    await sub.subscribe(REDIS_CHANNEL);

    sub.on("message", (_channel: string, message: string) => {
      try {
        const envelope: RedisEnvelope = JSON.parse(message);
        // Skip messages we published ourselves — already delivered locally
        if (envelope._origin === this._instanceId) return;
        // Emit locally using the original channel name for cross-instance delivery
        super.emit(envelope.channel, envelope.data);
      } catch {
        // Ignore malformed messages
      }
    });
  }

  // Override emit to publish to Redis when available
  emit(event: string | symbol, ...args: unknown[]): boolean {
    if (typeof event === "string" && isRedisEnabled()) {
      const pub = getRedisPublisher();
      if (pub && pub.status === "ready") {
        const envelope: RedisEnvelope = {
          _origin: this._instanceId,
          channel: event,
          data: args[0],
        };
        pub.publish(REDIS_CHANNEL, JSON.stringify(envelope)).catch(() => {
          // Silently fail — local emit still works
        });
      }
    }
    // Always emit locally for same-process consumers
    return super.emit(event, ...args);
  }

  emitPresence(event: PresenceEvent) {
    const key = `${event.agentUuid}:${event.entityType}:${event.entityUuid}${event.subEntityType ? `:${event.subEntityType}` : ""}${event.subEntityUuid ? `:${event.subEntityUuid}` : ""}`;
    const now = Date.now();
    const lastEmit = this._presenceThrottle.get(key);
    if (lastEmit && now - lastEmit < ChorusEventBus.THROTTLE_WINDOW_MS) {
      return; // Throttled
    }
    this._presenceThrottle.set(key, now);
    this._ensureEvictionTimer();
    this.emit("presence", event);
  }

  private _ensureEvictionTimer() {
    if (this._evictionTimer) return;
    this._evictionTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, ts] of this._presenceThrottle) {
        if (now - ts >= ChorusEventBus.EVICTION_TTL_MS) {
          this._presenceThrottle.delete(key);
        }
      }
      if (this._presenceThrottle.size === 0) {
        clearInterval(this._evictionTimer!);
        this._evictionTimer = null;
      }
    }, ChorusEventBus.EVICTION_INTERVAL_MS);
    // Don't block process exit
    if (this._evictionTimer && typeof this._evictionTimer === "object" && "unref" in this._evictionTimer) {
      this._evictionTimer.unref();
    }
  }

  /** Expose for testing */
  get _throttleMapSize() {
    return this._presenceThrottle.size;
  }

  /** Reset presence throttle state — test only */
  _resetPresenceState() {
    this._presenceThrottle.clear();
    if (this._evictionTimer) {
      clearInterval(this._evictionTimer);
      this._evictionTimer = null;
    }
  }

  emitChange(event: RealtimeEvent) {
    this.emit("change", event);
  }

  async disconnect(): Promise<void> {
    const pub = getRedisPublisher();
    const sub = getRedisSubscriber();
    if (sub) await sub.quit().catch(() => {});
    if (pub) await pub.quit().catch(() => {});
    this._connected = false;
  }
}

// Use globalThis to ensure a true process-level singleton across
// Next.js Route Handlers and Server Actions (which use separate module graphs)
const globalForEventBus = globalThis as unknown as {
  chorusEventBus: ChorusEventBus | undefined;
};

export const eventBus = (globalForEventBus.chorusEventBus ??= new ChorusEventBus());

// Auto-connect on import (non-blocking)
if (isRedisEnabled()) {
  eventBus.connect().catch((err) => {
    ebLogger.error({ err }, "Redis connect failed, falling back to memory");
  });
}
