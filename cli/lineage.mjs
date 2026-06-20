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
// dependency and reuses the same Bearer auth path. On any failure (unreachable
// server, non-2xx, malformed body) it returns both ids as null so the caller
// falls back to a per-entity session key — "no idea ancestor" is a normal,
// non-fatal outcome.

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
     * `{ rootIdeaUuid, directIdeaUuid }` so repeats of the same entity single-flight.
     * @type {Map<string, { rootIdeaUuid: string|null, directIdeaUuid: string|null }>}
     */
    this.cache = new Map();
  }

  /**
   * Resolve an event to its idea attribution `{ rootIdeaUuid, directIdeaUuid }`.
   * One REST call per notification; the per-run cache single-flights repeats of
   * the same entity. On any failure both ids are null (caller falls back to a
   * per-entity key). Never throws.
   * @param {{ entityType?: string, entityUuid?: string }} event
   * @returns {Promise<{ rootIdeaUuid: string|null, directIdeaUuid: string|null }>}
   */
  async resolve(event) {
    const entityType = event?.entityType;
    const entityUuid = event?.entityUuid;
    if (!entityType || !entityUuid) {
      this.logger.warn("[Chorus] lineage: event missing entityType/entityUuid");
      return { rootIdeaUuid: null, directIdeaUuid: null };
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

  /**
   * Call GET /api/entities/{type}/{uuid}/root-idea and return
   * `{ rootIdeaUuid, directIdeaUuid }` (each string | null). Returns both null on
   * any error so the caller degrades to a per-entity session key — never throws.
   * @param {string} entityType @param {string} entityUuid
   * @returns {Promise<{ rootIdeaUuid: string|null, directIdeaUuid: string|null }>}
   */
  async #resolveViaServer(entityType, entityUuid) {
    const NONE = { rootIdeaUuid: null, directIdeaUuid: null };
    const endpoint =
      `${this.url}/api/entities/${encodeURIComponent(entityType)}/` +
      `${encodeURIComponent(entityUuid)}/root-idea`;
    let response;
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
        `[Chorus] lineage: server returned ${response.status} for ${entityType}:${entityUuid}`
      );
      return NONE;
    }
    let body;
    try {
      body = await response.json();
    } catch (err) {
      this.logger.warn(`[Chorus] lineage: bad JSON for ${entityType}:${entityUuid}: ${err}`);
      return NONE;
    }
    // API envelope: { success: true, data: { rootIdeaUuid, directIdeaUuid, lineage, ... } }.
    const data = body && typeof body === "object" ? body.data : undefined;
    if (!data || typeof data !== "object" || !("rootIdeaUuid" in data)) {
      this.logger.warn(
        `[Chorus] lineage: unexpected response shape for ${entityType}:${entityUuid}`
      );
      return NONE;
    }
    const root = data.rootIdeaUuid;
    if (root !== null && typeof root !== "string") {
      this.logger.warn(`[Chorus] lineage: non-string rootIdeaUuid for ${entityType}:${entityUuid}`);
      return NONE;
    }
    // directIdeaUuid is the daemon's session anchor. Older servers may omit it
    // (pre-directIdeaUuid endpoint): treat a missing/non-string value as null so
    // the caller falls back to a per-entity key rather than misanchoring.
    const directRaw = data.directIdeaUuid;
    const direct = typeof directRaw === "string" ? directRaw : null;
    if (directRaw !== undefined && directRaw !== null && typeof directRaw !== "string") {
      this.logger.warn(
        `[Chorus] lineage: non-string directIdeaUuid for ${entityType}:${entityUuid}`
      );
    }
    this.logger.info(
      `[Chorus] lineage: ${entityType}:${entityUuid} → root ${root ?? "none"}, direct ${direct ?? "none"}` +
        (typeof data.resolvedVia === "string" ? ` (${data.resolvedVia})` : "")
    );
    return { rootIdeaUuid: root, directIdeaUuid: direct };
  }
}
