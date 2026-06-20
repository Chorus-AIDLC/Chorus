// packages/openclaw-plugin/src/lineage.ts
// Resolves any inbound Chorus notification/entity to its idea attribution, so the
// OpenClaw daemon client can anchor ONE embedded-agent session per DIRECT idea (the
// in-process analog of `claude --resume <directIdeaUuid>`) while reporting the ROOT
// idea in its execution snapshot for observability.
//
// TS mirror of `cli/lineage.mjs` (`LineageResolver`) — same single-source-of-truth
// REST contract, re-stated in TS because the plugin publishes standalone (it cannot
// import a file under `cli/`; see daemon-rest-client.ts for the same rationale).
//
// Resolution is fully SERVER-SIDE: every entity is resolved by a single call to the
// standalone REST endpoint
//   GET /api/entities/{type}/{uuid}/root-idea   (Bearer <cho_ agent key>)
// which returns BOTH `rootIdeaUuid` (topmost ancestor) and `directIdeaUuid` (the
// first idea node on the lineage). There is intentionally NO client-side lineage
// walk. On any failure (unreachable server, non-2xx, malformed body) it returns both
// ids as null so the caller falls back to a per-entity session key — "no idea
// ancestor" is a normal, non-fatal outcome. Uses global fetch (Node 18+) → no new dep.

export interface LineageLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

const NOOP_LOGGER: LineageLogger = { info() {}, warn() {}, error() {} };

/** The idea attribution of an entity. Both null when there's no idea ancestor. */
export interface LineageAttribution {
  rootIdeaUuid: string | null;
  directIdeaUuid: string | null;
}

const NONE: LineageAttribution = { rootIdeaUuid: null, directIdeaUuid: null };

export interface LineageResolverOptions {
  /** Chorus base URL. */
  url: string;
  /** `cho_` agent API key. */
  apiKey: string;
  logger?: LineageLogger;
  /** Injectable for tests (defaults to global fetch). */
  fetchImpl?: typeof fetch;
}

export class LineageResolver {
  private readonly url: string;
  private readonly apiKey: string;
  private readonly logger: LineageLogger;
  private readonly fetchImpl: typeof fetch;
  /** Per-run cache keyed by `${type}:${uuid}` so repeats single-flight. */
  private readonly cache = new Map<string, LineageAttribution>();

  constructor(opts: LineageResolverOptions) {
    this.url = opts.url.replace(/\/$/, "");
    this.apiKey = opts.apiKey;
    this.logger = opts.logger ?? NOOP_LOGGER;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  }

  /**
   * Resolve an entity to its idea attribution `{ rootIdeaUuid, directIdeaUuid }`.
   * One REST call per entity; the cache single-flights repeats. On any failure both
   * ids are null (caller falls back to a per-entity key). Never throws.
   */
  async resolve(event: {
    entityType?: string;
    entityUuid?: string;
  }): Promise<LineageAttribution> {
    const entityType = event?.entityType;
    const entityUuid = event?.entityUuid;
    if (!entityType || !entityUuid) {
      this.logger.warn("[Chorus] lineage: event missing entityType/entityUuid");
      return NONE;
    }
    // An ad-hoc conversation (`daemon_session`) has NO idea ancestor by definition,
    // and the root-idea endpoint does not accept it (it would 400). Short-circuit to
    // the null attribution the caller would fall back to anyway — avoiding a
    // guaranteed-failing round-trip + a spurious warn on every ad-hoc resume. The
    // caller then anchors the session on the entity uuid (= the ad-hoc sessionId).
    if (entityType === "daemon_session") {
      return NONE;
    }
    const cacheKey = `${entityType}:${entityUuid}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    const result = await this.resolveViaServer(entityType, entityUuid);
    this.cache.set(cacheKey, result);
    return result;
  }

  /**
   * Call GET /api/entities/{type}/{uuid}/root-idea and return
   * `{ rootIdeaUuid, directIdeaUuid }` (each string | null). Returns both null on any
   * error so the caller degrades to a per-entity session key — never throws.
   */
  private async resolveViaServer(
    entityType: string,
    entityUuid: string,
  ): Promise<LineageAttribution> {
    const endpoint =
      `${this.url}/api/entities/${encodeURIComponent(entityType)}/` +
      `${encodeURIComponent(entityUuid)}/root-idea`;
    let response: Response;
    try {
      response = await this.fetchImpl(endpoint, {
        headers: { Authorization: `Bearer ${this.apiKey}`, Accept: "application/json" },
      });
    } catch (err) {
      this.logger.warn(`[Chorus] lineage: request failed for ${entityType}:${entityUuid}: ${err}`);
      return NONE;
    }
    if (!response.ok) {
      this.logger.warn(
        `[Chorus] lineage: server returned ${response.status} for ${entityType}:${entityUuid}`,
      );
      return NONE;
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch (err) {
      this.logger.warn(`[Chorus] lineage: bad JSON for ${entityType}:${entityUuid}: ${err}`);
      return NONE;
    }
    // API envelope: { success: true, data: { rootIdeaUuid, directIdeaUuid, ... } }.
    const data =
      body && typeof body === "object" ? (body as { data?: unknown }).data : undefined;
    if (!data || typeof data !== "object" || !("rootIdeaUuid" in data)) {
      this.logger.warn(
        `[Chorus] lineage: unexpected response shape for ${entityType}:${entityUuid}`,
      );
      return NONE;
    }
    const root = (data as { rootIdeaUuid: unknown }).rootIdeaUuid;
    if (root !== null && typeof root !== "string") {
      this.logger.warn(`[Chorus] lineage: non-string rootIdeaUuid for ${entityType}:${entityUuid}`);
      return NONE;
    }
    // directIdeaUuid is the session anchor. Older servers may omit it: treat a
    // missing/non-string value as null so the caller falls back to a per-entity key.
    const directRaw = (data as { directIdeaUuid?: unknown }).directIdeaUuid;
    const direct = typeof directRaw === "string" ? directRaw : null;
    if (directRaw !== undefined && directRaw !== null && typeof directRaw !== "string") {
      this.logger.warn(
        `[Chorus] lineage: non-string directIdeaUuid for ${entityType}:${entityUuid}`,
      );
    }
    const resolvedVia = (data as { resolvedVia?: unknown }).resolvedVia;
    this.logger.info(
      `[Chorus] lineage: ${entityType}:${entityUuid} → root ${root ?? "none"}, direct ${direct ?? "none"}` +
        (typeof resolvedVia === "string" ? ` (${resolvedVia})` : ""),
    );
    return { rootIdeaUuid: root, directIdeaUuid: direct };
  }
}
