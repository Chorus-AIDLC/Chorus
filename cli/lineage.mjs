// cli/lineage.mjs
// Resolves any inbound Chorus notification to its ROOT idea, so the daemon can
// key one Claude session per root idea (the idea_root anchor). Verified field
// chains against the repo:
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
   * Resolve an event to its root idea uuid, or null if none.
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
    try {
      const startIdeaUuid = await this.#toIdeaUuid(entityType, entityUuid);
      root = startIdeaUuid ? await this.#walkToRoot(startIdeaUuid) : null;
    } catch (err) {
      this.logger.warn(`[Chorus] lineage resolution failed for ${cacheKey}: ${err}`);
      root = null;
    }
    this.cache.set(cacheKey, root);
    return root;
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
