// Pure, deterministic FOREST LAYOUT for the project resource graph's mind-map
// redesign. Framework-free (no React, no canvas) so it is unit-testable in
// isolation, mirroring resource-graph-visible-set.ts.
//
// Design notes (Tech Design D1 / D4 / D5)
// =======================================
//
// The resource graph data is a rooted FOREST, not an arbitrary graph. This
// module turns the already-computed *visible* node/link set into deterministic
// {x, y} coordinates for a horizontal (left -> right) mind-map and a pre-order
// DFS ordering (consumed by the mobile vertical outline).
//
// 1. TREE EDGES. The forest is built from `derive` + `lineage` + `depends`
//    edges; the parent of every non-root node is resolved as follows (the
//    stable contract per Tech Design D5 — DO NOT re-derive from raw
//    proposalUuid / sourceIdeaUuids here):
//      - Proposal / Document -> its `ownerId` hint (`ForceNode.ownerId` encodes
//        proposal -> source-idea and document -> proposal nesting; see
//        resource-graph.tsx#ownerOf).
//      - Task -> its first visible `depends` prerequisite when it has one (so a
//        dependent task nests UNDER the task it depends on and the DAG lays out
//        as a left->right chain); otherwise its `ownerId` proposal (root tasks).
//      - child Idea -> parent Idea, taken from the `lineage` edge whose `to`
//        end is this Idea (ideas carry no ownerId, so lineage is their parent
//        signal). Edge direction convention: `from` = parent, `to` = child;
//        for `depends`, `from` = prerequisite, `to` = dependent.
//    A multi-source proposal's SECONDARY source edges, and a multi-prerequisite
//    task's secondary `depends` edges, are NOT tree-spine edges — they are
//    cross-links drawn by the renderer but do not change a node's coordinates.
//
// 2. FOREST ROOTS. A node with no resolvable, present tree parent (a root
//    Idea, an orphan task/proposal, or a multi-source proposal's secondary
//    root) becomes its own forest root. Roots are laid out independently and
//    then STACKED VERTICALLY with a fixed gap so they never overlap.
//
// 3. DETERMINISM. d3-hierarchy's `d3.tree().nodeSize(...)` produces coordinates
//    that depend only on the tree shape (not on viewport size or any random
//    seed), and we preserve input order for siblings + roots. Identical inputs
//    therefore yield byte-identical coordinates.
//
// 4. HORIZONTAL ORIENTATION. d3.tree lays a node out with `x` on the breadth
//    (sibling) axis and `y = depth * dy`. For a left -> right mind-map we map
//    depth onto the horizontal axis and the breadth onto the vertical axis:
//      finalX = d3.y   (depth -> rightward)
//      finalY = d3.x   (siblings -> spread top/bottom)
//    Cards are fixed-height today (46px), so a constant node size is sufficient
//    for v1 (flextree-style variable sizing is a later refinement, not needed
//    here).

import { hierarchy, tree, type HierarchyPointNode } from "d3-hierarchy";

import type {
  ResourceGraphNodeType,
  ResourceGraphEdgeKind,
} from "@/services/resource-graph.service";

// --- Input contract ---------------------------------------------------------
//
// These are the layout inputs. They are intentionally structurally compatible
// with the `ForceNode` / `ForceLink` shapes the parent (resource-graph.tsx)
// already produces, but defined HERE so the layout module is self-contained and
// does not depend on the canvas component (which is being rewritten). The
// canvas can import these types from this stable module.

export interface TreeLayoutNode {
  id: string;
  type: ResourceGraphNodeType;
  title: string;
  /** Hub-only (Idea or Proposal): number of direct children. */
  childCount?: number;
  /** Hub-only: whether currently expanded. */
  expanded?: boolean;
  /** True when this node should show an expand/collapse affordance. */
  hasAffordance?: boolean;
  /**
   * Tree-parent hint for non-Idea nodes: a Proposal's owner is its source
   * Idea; a Task/Document's owner is its Proposal. Idea hubs and orphans have
   * none. Child-Idea parentage is NOT carried here — it comes from `lineage`
   * edges (see module note 1).
   */
  ownerId?: string;
}

export interface TreeLayoutLink {
  source: string;
  target: string;
  kind: ResourceGraphEdgeKind;
}

// --- Output contract ---------------------------------------------------------

/** A laid-out node: the original node plus its deterministic coordinates + depth. */
export interface PositionedNode {
  /** The input node id. */
  id: string;
  /** Horizontal coordinate (derivation depth grows rightward). */
  x: number;
  /** Vertical coordinate (siblings spread; forest roots stack). */
  y: number;
  /** 0 for a forest root, +1 per derivation level. */
  depth: number;
}

/** A single entry in the pre-order DFS ordering (consumed by the mobile outline). */
export interface OutlineEntry {
  /** The input node id. */
  id: string;
  /** 0 for a forest root, +1 per derivation level. Drives indentation. */
  depth: number;
}

export interface TreeLayoutResult {
  /** Deterministic coordinates per node, keyed by node id. */
  positions: Map<string, PositionedNode>;
  /**
   * Pre-order DFS ordering of the whole forest (roots in input order, then
   * each root's subtree pre-order). Each entry carries its depth.
   */
  outline: OutlineEntry[];
  /**
   * The resolved tree-spine parent of each non-root node, keyed by child id.
   * This is the SINGLE source of truth for which edge positioned a node, so the
   * renderer can decide "is this link a solid tree connector?" consistently
   * with the layout (an edge `from -> to` is a spine edge iff
   * `treeParentById.get(to) === from`). Forest roots are absent from the map.
   */
  treeParentById: Map<string, string>;
}

// --- Tunables ----------------------------------------------------------------
//
// Node-size units fed to d3.tree().nodeSize([breadth, depth]). Because we
// rotate the layout (note 4), the FIRST entry is the vertical spacing between
// sibling cards and the SECOND is the horizontal spacing between derivation
// levels. Cards are 46px tall / 200px wide today, so these gaps clear them with
// breathing room.
const ROW_GAP = 72; // vertical distance between sibling rows
const COL_GAP = 280; // horizontal distance between derivation levels
/** Fixed vertical gap inserted between successive forest roots' subtrees. */
const ROOT_GAP = 96;

// --- Internal tree shape -----------------------------------------------------

interface ForestDatum {
  id: string;
  children: ForestDatum[];
}

/**
 * Compute the deterministic forest layout for a visible node/link set.
 *
 * Builds the forest from `derive` + `lineage` edges only (note 1), lays out
 * each tree with d3-hierarchy at a fixed node size, stacks multiple roots
 * vertically (note 2), and returns both per-node coordinates and a pre-order
 * DFS outline ordering with depth.
 *
 * @param nodes The visible nodes (already filtered by the visible-set model).
 * @param links The visible links. Only `derive` + `lineage` are tree edges;
 *   `depends` and any other kinds are ignored for layout.
 */
export function computeTreeLayout(
  nodes: readonly TreeLayoutNode[],
  links: readonly TreeLayoutLink[],
): TreeLayoutResult {
  const nodeById = new Map<string, TreeLayoutNode>();
  for (const n of nodes) nodeById.set(n.id, n);

  // --- 1. Resolve each node's tree parent ----------------------------------
  // For child Ideas, the parent is the `from` end of the lineage edge that
  // ends at this Idea. We index lineage targets -> source. (Edge direction:
  // from = parent, to = child.) Only `lineage` edges contribute Idea parentage;
  // non-Idea nodes use their ownerId hint. A parent that is not in the visible
  // node set is treated as absent (node becomes a forest root).
  const lineageParentOf = new Map<string, string>();
  const dependsParentOf = new Map<string, string>();
  for (const l of links) {
    if (l.kind === "lineage") {
      // Guard against malformed duplicate lineage edges: first one wins,
      // keeping the result deterministic w.r.t. input order.
      if (!lineageParentOf.has(l.target)) {
        lineageParentOf.set(l.target, l.source);
      }
    } else if (l.kind === "depends") {
      // A `depends` edge is source = prerequisite, target = dependent task. We
      // nest the dependent UNDER its prerequisite so the task DAG lays out as a
      // left->right chain (proposal -> root task -> dependent -> …) and its
      // connectors read as ordinary tree lines rather than backward links
      // between same-column siblings. First prerequisite wins (deterministic);
      // any further prerequisites of a multi-dependency task stay as plain
      // cross-links, drawn but not part of the tree spine.
      if (!dependsParentOf.has(l.target)) {
        dependsParentOf.set(l.target, l.source);
      }
    }
  }

  const parentOf = (n: TreeLayoutNode): string | undefined => {
    if (n.type === "idea") {
      const p = lineageParentOf.get(n.id);
      return p !== undefined && nodeById.has(p) ? p : undefined;
    }
    if (n.type === "task") {
      // Dependent task -> its (visible) prerequisite; root task (no in-proposal
      // prerequisite) -> its proposal via ownerId. Fall back to the proposal if
      // the prerequisite isn't currently visible.
      const dep = dependsParentOf.get(n.id);
      if (dep !== undefined && nodeById.has(dep)) return dep;
      return n.ownerId !== undefined && nodeById.has(n.ownerId)
        ? n.ownerId
        : undefined;
    }
    // proposal / document -> its owner (idea / proposal) when visible.
    return n.ownerId !== undefined && nodeById.has(n.ownerId)
      ? n.ownerId
      : undefined;
  };

  // --- 2. Build the forest (children indexed by parent, input order kept) ---
  const childrenByParent = new Map<string, TreeLayoutNode[]>();
  const treeParentById = new Map<string, string>();
  const rootNodes: TreeLayoutNode[] = [];
  // Iterate in input order so sibling + root ordering is deterministic.
  for (const n of nodes) {
    const parent = parentOf(n);
    if (parent === undefined) {
      rootNodes.push(n);
    } else {
      treeParentById.set(n.id, parent);
      const bucket = childrenByParent.get(parent);
      if (bucket) bucket.push(n);
      else childrenByParent.set(parent, [n]);
    }
  }

  // Recursively build the datum tree for one root. A `seen` set guards against
  // a pathological cycle in the parent links (should never happen for a valid
  // forest, but keeps the layout total and terminating).
  const buildDatum = (
    node: TreeLayoutNode,
    seen: Set<string>,
  ): ForestDatum => {
    seen.add(node.id);
    const kids = childrenByParent.get(node.id) ?? [];
    const children: ForestDatum[] = [];
    for (const kid of kids) {
      if (seen.has(kid.id)) continue; // break cycles defensively
      children.push(buildDatum(kid, seen));
    }
    return { id: node.id, children };
  };

  // --- 3. Lay out each tree, then stack roots vertically -------------------
  const layout = tree<ForestDatum>().nodeSize([ROW_GAP, COL_GAP]);

  const positions = new Map<string, PositionedNode>();
  const outline: OutlineEntry[] = [];

  // Running vertical offset so successive trees never overlap.
  let yCursor = 0;

  for (const root of rootNodes) {
    const datum = buildDatum(root, new Set<string>());
    const h = hierarchy<ForestDatum>(datum);
    layout(h);

    // After layout (and BEFORE rotation): d3 `node.x` is the breadth axis,
    // `node.y` is depth. Find this tree's vertical (breadth) extent so we can
    // shift it to start just below the previous tree.
    let minBreadth = Infinity;
    let maxBreadth = -Infinity;
    h.each((d) => {
      const pn = d as HierarchyPointNode<ForestDatum>;
      if (pn.x < minBreadth) minBreadth = pn.x;
      if (pn.x > maxBreadth) maxBreadth = pn.x;
    });
    // Single-node trees have x === 0 for the root.
    if (!Number.isFinite(minBreadth)) {
      minBreadth = 0;
      maxBreadth = 0;
    }
    // Shift so this tree's top breadth sits at the current cursor.
    const shift = yCursor - minBreadth;

    // Pre-order DFS (eachBefore) gives the outline ordering AND the positions.
    h.eachBefore((d) => {
      const pn = d as HierarchyPointNode<ForestDatum>;
      const id = pn.data.id;
      positions.set(id, {
        id,
        // Rotate to left -> right: depth (d3 y) -> horizontal,
        // breadth (d3 x) -> vertical.
        x: pn.y,
        y: pn.x + shift,
        depth: pn.depth,
      });
      outline.push({ id, depth: pn.depth });
    });

    // Advance the cursor past this tree plus a fixed gap.
    yCursor = maxBreadth + shift + ROOT_GAP;
  }

  return { positions, outline, treeParentById };
}
