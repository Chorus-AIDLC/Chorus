// Force-directed layout for the project resource graph.
//
// Pure, React-free wrapper around d3-force. Operates on the generic
// aggregation contract from the tech design — nodes carry a `uuid` and edges
// carry `{ from, to, kind }` — so the same function lays out any subset of the
// graph (e.g. after expand/collapse) without coupling to the renderer.
//
// d3-force v3 verified against the installed package: forceSimulation,
// forceLink (with `.id(accessor)` to map link.source/target from a string
// identifier to the node object on initialization), forceManyBody,
// forceCenter, forceCollide. The simulation is driven manually with
// stop() + tick(n) so the result is synchronous and deterministic — no timer,
// no animation loop — suitable for unit tests and React render seeding.

import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";

/**
 * Minimum shape a graph node needs for layout. The renderer's full node
 * (`type`, `title`, `derivativeCount`, ...) is a superset of this; layout only
 * needs the identifier.
 */
export interface LayoutNodeInput {
  uuid: string;
}

/**
 * Minimum shape a graph edge needs for layout. The renderer carries `kind`
 * (`derive` | `lineage` | `depends`) for styling; layout doesn't care about
 * kind, only that the edge connects two nodes.
 */
export interface LayoutEdgeInput {
  from: string;
  to: string;
}

export interface Position {
  x: number;
  y: number;
}

export interface LayoutOptions {
  /** Center of the simulation viewport. Defaults to (0, 0). */
  centerX?: number;
  centerY?: number;
  /** Per-link target distance fed to forceLink.distance(). Default 120. */
  linkDistance?: number;
  /** Charge strength fed to forceManyBody.strength(). Default -300 (repulsion). */
  chargeStrength?: number;
  /** Collision radius — minimum spacing between node centers. Default 56. */
  collideRadius?: number;
  /**
   * Number of simulation ticks to run when laying out from scratch.
   * d3-force naturally converges in ~300 ticks at default alphaDecay.
   */
  ticks?: number;
  /**
   * When `prevPositions` is supplied, run this many ticks at low alpha so
   * positions shift incrementally instead of re-randomizing. Default 60.
   */
  incrementalTicks?: number;
  /**
   * Alpha used for incremental (prevPositions) runs. Default 0.3 — high enough
   * for forces to nudge nodes apart when new ones appear, low enough that the
   * graph doesn't jump.
   */
  incrementalAlpha?: number;
}

/** Internal node datum carried through the simulation. */
interface SimNode extends SimulationNodeDatum {
  uuid: string;
}

/** Internal link datum. Strings get resolved to SimNode refs by forceLink. */
type SimLink = SimulationLinkDatum<SimNode>;

/**
 * Deterministic linear-congruential pseudo-random source.
 * d3-force calls this for initial phyllotaxis placement and to jiggle nodes
 * that share the exact same position; a fixed seed makes the entire layout
 * reproducible, which is what the tests rely on.
 */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    // Numerical Recipes LCG; good enough for tie-breaking, not cryptography.
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/**
 * Compute force-directed positions for the given nodes and edges.
 *
 * @param nodes  Graph nodes; only `uuid` is required.
 * @param edges  Graph edges keyed by uuid (`from` → `to`).
 * @param prevPositions  Previous (uuid → {x,y}) map. When supplied, any node
 *   present in the map seeds its initial x/y from there and the simulation
 *   runs at low alpha — so the same nodes stay close to where they were,
 *   while newly-added nodes settle into place around them. This is what the
 *   expand/collapse interaction needs to preserve the user's mental map.
 * @returns Map of uuid → settled position. Every input node gets an entry.
 */
export function layoutResourceGraph(
  nodes: LayoutNodeInput[],
  edges: LayoutEdgeInput[],
  prevPositions?: ReadonlyMap<string, Position> | null,
  options: LayoutOptions = {},
): Map<string, Position> {
  const {
    centerX = 0,
    centerY = 0,
    linkDistance = 120,
    chargeStrength = -300,
    collideRadius = 56,
    ticks = 300,
    incrementalTicks = 60,
    incrementalAlpha = 0.3,
  } = options;

  const result = new Map<string, Position>();
  if (nodes.length === 0) return result;

  // Build SimNode array. When prevPositions has an entry, seed x/y from it so
  // d3-force keeps the node near its prior coordinates; otherwise leave x/y
  // undefined and let d3 lay it out in the default phyllotaxis arrangement.
  const simNodes: SimNode[] = nodes.map((n) => {
    const prev = prevPositions?.get(n.uuid);
    const sim: SimNode = { uuid: n.uuid };
    if (prev) {
      sim.x = prev.x;
      sim.y = prev.y;
    }
    return sim;
  });

  // Drop edges that reference nodes not in this layout pass. This is
  // defensive: if a caller filters the visible node set for collapse, any
  // stale edge would crash forceLink with "node not found".
  const known = new Set(nodes.map((n) => n.uuid));
  const simLinks: SimLink[] = edges
    .filter((e) => known.has(e.from) && known.has(e.to))
    .map((e) => ({ source: e.from, target: e.to }));

  const hasSeed = prevPositions !== undefined && prevPositions !== null;

  const sim = forceSimulation<SimNode, SimLink>(simNodes)
    // Deterministic random source. We derive the seed from the node count so
    // independent graphs don't all collapse to the same phyllotaxis spiral,
    // but each (nodes, edges) pair always produces the same output.
    .randomSource(seededRandom(0x9e3779b9 ^ simNodes.length))
    .force(
      "link",
      forceLink<SimNode, SimLink>(simLinks)
        .id((d) => d.uuid)
        .distance(linkDistance),
    )
    .force("charge", forceManyBody<SimNode>().strength(chargeStrength))
    .force("center", forceCenter<SimNode>(centerX, centerY))
    .force("collide", forceCollide<SimNode>(collideRadius));

  // Run the simulation synchronously — stop the internal timer and tick by
  // hand so this function returns settled positions immediately.
  sim.stop();
  if (hasSeed) {
    // Incremental run: lower alpha + fewer ticks so existing nodes stay near
    // their seeded positions and only newcomers move much.
    sim.alpha(incrementalAlpha);
    sim.tick(incrementalTicks);
  } else {
    sim.tick(ticks);
  }

  for (const sn of simNodes) {
    result.set(sn.uuid, { x: sn.x ?? 0, y: sn.y ?? 0 });
  }
  return result;
}
