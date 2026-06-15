// cli/lineage.mjs
// Resolves any inbound Chorus notification to its ROOT idea, so the daemon can
// key one Claude session per root idea (the idea_root anchor).
//
// SERVER-FIRST with a client-side fallback (cli-daemon spec "Lineage-anchored
// session continuity"): the daemon prefers the server tool chorus_resolve_root_idea
// (the single source of truth — it closes the document-attribution gap and defines
// multi-idea semantics). When that tool is unavailable (an older server that does
// not register it, or a transport error that survived ChorusClient's one retry),
// the daemon falls back to the original client-side walk so attribution still
// works against any server version. A well-formed server response — INCLUDING a
// rootIdeaUuid of null — is authoritative and never triggers the fallback.
//
// Client-side fallback walk (verified field chains against the repo):
//   • get_task → { proposalUuid: string | null }            (task.service.ts)
//   • get_proposal → { inputType, inputUuids: string[] }     (proposal.service.ts)
//       an idea-derived proposal has inputType "idea" and inputUuids[0] = idea
//   • get_idea → { parentUuid: string | null }               (idea.service.ts)
//       walk parentUuid to the top of the single-parent lineage forest
//
// All Chorus reads go through the injected ChorusMcpClient.callTool (contract:
// never hand-roll fetch). Returns null when there is no idea ancestor (e.g. a
// quick task with no proposal/idea) so the caller can fall back to a per-entity
// session key.

const NOOP_LOGGER = { info() {}, warn() {}, error() {} };
const MAX_PARENT_HOPS = 50; // cycle/runaway guard

export class LineageResolver {
  /**
   * @param {{
   *   mcpClient: { callTool: (name: string, args?: Record<string, unknown>) => Promise<any> },
   *   logger?: { info(m:string):void, warn(m:string):void, error(m:string):void },
   * }} opts
   */
  constructor(opts) {
    this.mcp = opts.mcpClient;
    this.logger = opts.logger ?? NOOP_LOGGER;
    /** @type {Map<string, string|null>} per-run cache keyed by `${type}:${uuid}`. */
    this.cache = new Map();
  }

  /**
   * Resolve an event to its root idea uuid, or null if none. Server-first: prefer
   * the chorus_resolve_root_idea tool; fall back to the client-side walk only when
   * that tool is unavailable. The per-run cache single-flights both paths.
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

    let root = null;
    // 1) Prefer the server-side resolver (single source of truth).
    const server = await this.#resolveViaServer(entityType, entityUuid);
    if (server.ok) {
      root = server.rootIdeaUuid;
      this.logger.info(
        `[Chorus] lineage(server): ${cacheKey} → ${root ?? "none"}` +
          (server.resolvedVia ? ` (${server.resolvedVia})` : "")
      );
    } else {
      // 2) Fall back to the client-side walk (older server / unavailable tool).
      this.logger.info(
        `[Chorus] lineage(fallback): ${cacheKey} — server resolver unavailable (${server.reason})`
      );
      try {
        const startIdeaUuid = await this.#toIdeaUuid(entityType, entityUuid);
        root = startIdeaUuid ? await this.#walkToRoot(startIdeaUuid) : null;
      } catch (err) {
        this.logger.warn(`[Chorus] lineage resolution failed for ${cacheKey}: ${err}`);
        root = null;
      }
    }
    this.cache.set(cacheKey, root);
    return root;
  }

  /**
   * Call the server-side chorus_resolve_root_idea tool. Returns a discriminated
   * result: { ok:true, rootIdeaUuid, resolvedVia } when the server answered with a
   * well-formed payload (rootIdeaUuid string-or-null — authoritative, including
   * null), or { ok:false, reason } when the tool is unavailable / non-conforming /
   * errored, signalling the caller to use the client-side fallback.
   * @param {string} entityType @param {string} entityUuid
   */
  async #resolveViaServer(entityType, entityUuid) {
    let result;
    try {
      result = await this.mcp.callTool("chorus_resolve_root_idea", { entityType, entityUuid });
    } catch (err) {
      // ChorusClient has already retried once on a transport/session error, so any
      // throw here means: unknown tool (older server) or a persistent failure.
      // Either way, fall back — the client walk is the safe path.
      return { ok: false, reason: `call-error: ${err?.message ?? err}` };
    }
    // A well-formed response is an object carrying a rootIdeaUuid of string|null.
    // Anything else (null, primitive, missing/!=type field) means the tool isn't
    // really there (older server returned an empty/parse-fallback body) — fall back.
    if (
      result &&
      typeof result === "object" &&
      "rootIdeaUuid" in result &&
      (typeof result.rootIdeaUuid === "string" || result.rootIdeaUuid === null)
    ) {
      return {
        ok: true,
        rootIdeaUuid: result.rootIdeaUuid,
        resolvedVia: typeof result.resolvedVia === "string" ? result.resolvedVia : undefined,
      };
    }
    return { ok: false, reason: "non-conforming-shape" };
  }

  /**
   * Map an entity to the idea uuid it belongs to (not yet walked to root).
   * @param {string} entityType @param {string} entityUuid
   * @returns {Promise<string|null>}
   */
  async #toIdeaUuid(entityType, entityUuid) {
    switch (entityType) {
      case "idea":
        return entityUuid;
      case "proposal":
        return this.#ideaFromProposal(entityUuid);
      case "task": {
        const task = await this.mcp.callTool("chorus_get_task", { taskUuid: entityUuid });
        const proposalUuid = task?.proposalUuid;
        if (!proposalUuid) return null; // quick task, no proposal/idea ancestor
        return this.#ideaFromProposal(proposalUuid);
      }
      case "document": {
        // Documents materialize from a proposal; reuse the proposal path if the
        // event carries one, else no idea ancestor.
        return null;
      }
      default:
        return null;
    }
  }

  /** @param {string} proposalUuid @returns {Promise<string|null>} */
  async #ideaFromProposal(proposalUuid) {
    const proposal = await this.mcp.callTool("chorus_get_proposal", { proposalUuid });
    if (proposal?.inputType !== "idea") return null;
    const inputUuids = Array.isArray(proposal.inputUuids) ? proposal.inputUuids : [];
    return inputUuids.length > 0 ? inputUuids[0] : null;
  }

  /**
   * Walk parentUuid to the top of the lineage forest.
   * @param {string} ideaUuid @returns {Promise<string>}
   */
  async #walkToRoot(ideaUuid) {
    let current = ideaUuid;
    const visited = new Set([current]);
    for (let hop = 0; hop < MAX_PARENT_HOPS; hop++) {
      const idea = await this.mcp.callTool("chorus_get_idea", { ideaUuid: current });
      const parent = idea?.parentUuid;
      if (!parent) return current; // reached a root
      if (visited.has(parent)) {
        this.logger.warn(`[Chorus] lineage: parent cycle detected at ${parent}, stopping`);
        return current;
      }
      visited.add(parent);
      current = parent;
    }
    this.logger.warn(`[Chorus] lineage: exceeded ${MAX_PARENT_HOPS} parent hops, stopping at ${current}`);
    return current;
  }
}
