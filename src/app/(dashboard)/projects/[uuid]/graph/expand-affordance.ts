// Pure helper shared by the resource-graph canvas + tests: should a node
// render an expand/collapse affordance?
//
// The graph uses a TWO-LEVEL expand model: an Idea expands to its Proposals,
// and a Proposal expands to its Tasks + Documents. So BOTH Idea and Proposal
// hubs can carry an affordance — any hub with at least one direct child.
// Tasks and Documents are leaves (level 2 is the bottom) and never expand.
//
// Kept dependency-free so the canvas painter and the visible-set tests can
// assert leaf-detection symmetry without pulling in the renderer.

export type ResourceGraphNodeType = "idea" | "proposal" | "task" | "document";

export function shouldShowExpandAffordance(
  type: ResourceGraphNodeType,
  childCount: number | undefined,
): boolean {
  return (type === "idea" || type === "proposal") && (childCount ?? 0) > 0;
}
