// cli/lineage.mjs
// Resolves any inbound Chorus notification to its ROOT idea, so the daemon can
// key one Claude session per root idea (the idea_root anchor).
//
// Resolution is fully SERVER-SIDE: every notification is resolved by a single
// call to the standalone REST endpoint
//   GET /api/entities/{type}/{uuid}/root-idea   (Bearer <cho_ agent key>)
// which is the single source of truth for entity → root-idea attribution
// (it closes the document-attribution gap and defines multi-idea semantics).
// There is intentionally NO client-side lineage walk — the whole point of this
// change is to stop the daemon re-implementing the Chorus data model.
//
// Uses global fetch (Node 18+), exactly like sse-listener.mjs, so it adds no
// dependency and reuses the same Bearer auth path. On any failure (unreachable
// server, non-2xx, malformed body) it returns null so the caller falls back to
// a per-entity session key — "no root idea" is a normal, non-fatal outcome.

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
    /** @type {Map<string, string|null>} per-run cache keyed by `${type}:${uuid}`. */
    this.cache = new Map();
  }

  /**
   * Resolve an event to its root idea uuid, or null if none. One REST call per
   * notification; the per-run cache single-flights repeats of the same entity.
   * @param {{ entityType?: string, entityUuid?: string }} event
   * @returns {Promise<string|null>}
   */
  async rootIdeaFor(event) {
    const entityType = event?.entityType;
    const entityUuid = event?.entityUuid;
    if (!entityType || !entityUuid) {
      this.logger.warn("[Chorus] lineage: event missing entityType/entityUuid");
      return null;
    }
    const cacheKey = `${entityType}:${entityUuid}`;
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey);

    const root = await this.#resolveViaServer(entityType, entityUuid);
    this.cache.set(cacheKey, root);
    return root;
  }

  /**
   * Call GET /api/entities/{type}/{uuid}/root-idea and return the rootIdeaUuid
   * (string | null). Returns null on any error so the caller degrades to a
   * per-entity session key — never throws.
   * @param {string} entityType @param {string} entityUuid
   * @returns {Promise<string|null>}
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
    } catch (err) {
      this.logger.warn(`[Chorus] lineage: request failed for ${entityType}:${entityUuid}: ${err}`);
      return null;
    }
    if (!response.ok) {
      this.logger.warn(
        `[Chorus] lineage: server returned ${response.status} for ${entityType}:${entityUuid}`
      );
      return null;
    }
    let body;
    try {
      body = await response.json();
    } catch (err) {
      this.logger.warn(`[Chorus] lineage: bad JSON for ${entityType}:${entityUuid}: ${err}`);
      return null;
    }
    // API envelope: { success: true, data: { rootIdeaUuid, lineage, resolvedVia, ... } }.
    const data = body && typeof body === "object" ? body.data : undefined;
    if (!data || typeof data !== "object" || !("rootIdeaUuid" in data)) {
      this.logger.warn(
        `[Chorus] lineage: unexpected response shape for ${entityType}:${entityUuid}`
      );
      return null;
    }
    const root = data.rootIdeaUuid;
    if (root !== null && typeof root !== "string") {
      this.logger.warn(`[Chorus] lineage: non-string rootIdeaUuid for ${entityType}:${entityUuid}`);
      return null;
    }
    this.logger.info(
      `[Chorus] lineage: ${entityType}:${entityUuid} → ${root ?? "none"}` +
        (typeof data.resolvedVia === "string" ? ` (${data.resolvedVia})` : "")
    );
    return root;
  }
}
