// cli/lineage.mjs
// Resolves any inbound Chorus notification to its idea attribution, so the daemon
// can anchor one Claude session per DIRECT idea (the entity's directly-attached
// idea) while still reporting the ROOT idea for observability.
//
// Resolution is fully SERVER-SIDE: every notification is resolved by a single
// call to the standalone REST endpoint
//   GET /api/entities/{type}/{uuid}/root-idea   (Bearer <cho_ agent key>)
// which is the single source of truth for entity → idea attribution (it closes
// the document-attribution gap and defines multi-idea semantics). The endpoint
// returns BOTH `rootIdeaUuid` (topmost ancestor) and `directIdeaUuid` (the first
// idea node on the lineage — the entity's directly-attached idea). There is
// intentionally NO client-side lineage walk — the whole point of this change is
// to stop the daemon re-implementing the Chorus data model.
//
// The daemon anchors the Claude `--session-id` on the DIRECT idea (so a human can
// `claude --resume <idea-uuid>` to take over), and reports the ROOT idea in its
// execution snapshot — the two are threaded separately, never derived from each
// other (see waker.mjs).
//
// Uses global fetch (Node 18+), exactly like sse-listener.mjs, so it adds no
// dependency and reuses the same Bearer auth path. Failed resolution rejects
// without caching; successful null attribution means "no idea ancestor".

const NOOP_LOGGER = { info() {}, warn() {}, error() {} };

export class LineageResolver {
  /**
   * @param {{
   *   url: string,        Chorus base URL.
   *   apiKey: string,     `cho_` agent API key.
   *   logger?: { info(m:string):void, warn(m:string):void, error(m:string):void },
   *   fetchImpl?: typeof fetch,  Injectable for tests.
   * }} opts
   */
  constructor(opts) {
    this.url = opts.url.replace(/\/$/, "");
    this.apiKey = opts.apiKey;
    this.logger = opts.logger ?? NOOP_LOGGER;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    /**
     * Per-run cache keyed by `${type}:${uuid}`. Holds the full attribution
     * `{ rootIdeaUuid, directIdeaUuid }` for successful resolutions only.
     * @type {Map<string, { rootIdeaUuid: string|null, directIdeaUuid: string|null }>}
     */
    this.cache = new Map();
  }

  /**
   * Resolve an event to its idea attribution `{ rootIdeaUuid, directIdeaUuid }`.
   * Successful resolutions are cached per entity. Failures reject with safe
   * deliveryRetryable/status metadata and are never cached.
   * @param {{ entityType?: string, entityUuid?: string }} event
   * @returns {Promise<{ rootIdeaUuid: string|null, directIdeaUuid: string|null }>}
   */
  async resolve(event) {
    const entityType = event?.entityType;
    const entityUuid = event?.entityUuid;
    if (typeof entityType !== "string" || !entityType.trim() || typeof entityUuid !== "string" || !entityUuid.trim()) {
      throw this.#failure("LINEAGE_INVALID_ENTITY", 400);
    }
    // An ad-hoc conversation (`daemon_session`) has NO idea ancestor by definition, and
    // the root-idea endpoint does not accept it (it would 400). Short-circuit to the
    // null attribution the caller would fall back to anyway — avoiding a guaranteed-failing
    // round-trip + a spurious warn on every ad-hoc resume. The caller then anchors the
    // Claude session on the entity uuid (= the ad-hoc sessionId), which is exactly right.
    if (entityType === "daemon_session") {
      return { rootIdeaUuid: null, directIdeaUuid: null };
    }
    const cacheKey = `${entityType}:${entityUuid}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    const result = await this.#resolveViaServer(entityType, entityUuid);
    this.cache.set(cacheKey, result);
    return result;
  }

  /**
   * Back-compat convenience: resolve an event to just its root idea uuid (or null).
   * @param {{ entityType?: string, entityUuid?: string }} event
   * @returns {Promise<string|null>}
   */
  async rootIdeaFor(event) {
    return (await this.resolve(event)).rootIdeaUuid;
  }

  #failure(code, status) {
    const error = new Error(`Lineage resolution failed (${code})`);
    error.code = code;
    if (status !== undefined) error.status = status;
    error.deliveryRetryable = !status || status === 408 || status === 429 || status >= 500;
    this.logger.warn(`[Chorus] lineage: ${code} status=${status ?? "unknown"}`);
    return error;
  }

  /**
   * Call GET /api/entities/{type}/{uuid}/root-idea and return
   * `{ rootIdeaUuid, directIdeaUuid }` (each string | null). Rejects on failure.
   * @param {string} entityType @param {string} entityUuid
   * @returns {Promise<{ rootIdeaUuid: string|null, directIdeaUuid: string|null }>}
   */
  async #resolveViaServer(entityType, entityUuid) {
    const endpoint =
      `${this.url}/api/entities/${encodeURIComponent(entityType)}/` +
      `${encodeURIComponent(entityUuid)}/root-idea`;
    let response;
    try {
      response = await this.fetchImpl(endpoint, {
        headers: { Authorization: `Bearer ${this.apiKey}`, Accept: "application/json" },
      });
    } catch {
      throw this.#failure("LINEAGE_REQUEST_FAILED");
    }
    if (!response.ok) {
      throw this.#failure("LINEAGE_HTTP_ERROR", response.status);
    }
    let body;
    try {
      body = await response.json();
    } catch {
      throw this.#failure("LINEAGE_INVALID_JSON");
    }
    // API envelope: { success: true, data: { rootIdeaUuid, directIdeaUuid, lineage, ... } }.
    const data = body && typeof body === "object" ? body.data : undefined;
    if (body?.success === false || !data || typeof data !== "object" || Array.isArray(data) || !("rootIdeaUuid" in data)) {
      throw this.#failure("LINEAGE_INVALID_RESPONSE");
    }
    const root = data.rootIdeaUuid;
    if (root !== null && (typeof root !== "string" || !root.trim())) {
      throw this.#failure("LINEAGE_INVALID_RESPONSE");
    }
    // directIdeaUuid is the daemon's session anchor. Older servers may omit it
    // (pre-directIdeaUuid endpoint): treat a missing value as null so
    // the caller falls back to a per-entity key rather than misanchoring.
    const directRaw = data.directIdeaUuid;
    const direct = typeof directRaw === "string" ? directRaw : null;
    if (directRaw !== undefined && directRaw !== null && (typeof directRaw !== "string" || !directRaw.trim())) {
      throw this.#failure("LINEAGE_INVALID_RESPONSE");
    }
    // A non-null ROOT idea with a null/absent DIRECT idea is a lineage gap: the wake will
    // anchor the execution on the entity (task/proposal), never on the idea conversation,
    // so its run shows no running indicator / Interrupt on the idea chat — permanently, for
    // this class of wake. The overwhelmingly likely cause is a Chorus server that predates
    // the `directIdeaUuid` field on the /root-idea endpoint. Surface it as a visible WARN
    // rather than folding it into the generic success `info` below (where it is
    // indistinguishable from the legitimate "no idea ancestor" outcome, root=direct=null).
    // Diagnostic ONLY — we do NOT substitute the root for the missing direct idea: for a
    // DERIVED child idea root ≠ direct, so falling back to root would light the PARENT
    // conversation and leave the child (which owns the woken session) idle. The correct fix
    // is server-side; this warn points the operator straight at it.
    if (root !== null && direct === null) {
      this.logger.warn(
        `[Chorus] lineage: ${entityType}:${entityUuid} resolved a root idea (${root}) but NO ` +
          `directIdeaUuid — this wake will anchor on the entity, not the idea conversation, ` +
          `so its run will not show a running indicator / Interrupt on the idea chat. Most ` +
          `likely the Chorus server predates the directIdeaUuid field on /root-idea; upgrade ` +
          `the server to restore child-wake → idea-conversation matching.`
      );
    }
    this.logger.info(
      `[Chorus] lineage: ${entityType}:${entityUuid} → root ${root ?? "none"}, direct ${direct ?? "none"}` +
        (typeof data.resolvedVia === "string" ? ` (${data.resolvedVia})` : "")
    );
    return { rootIdeaUuid: root, directIdeaUuid: direct };
  }
}
