// Pure helper shared by the resource-graph canvas + tests: should a node
// render an expand/collapse affordance?
//
// Only Idea nodes with at least one direct derivative qualify — Tasks,
// Documents, and Proposals are leaves in the expand model (only Ideas are
// hubs). Kept dependency-free so both the canvas painter and the visible-set
// tests can assert leaf-detection symmetry without pulling in the renderer.

export type ResourceGraphNodeType = "idea" | "proposal" | "task" | "document";

export function shouldShowExpandAffordance(
  type: ResourceGraphNodeType,
  derivativeCount: number | undefined,
): boolean {
  return type === "idea" && (derivativeCount ?? 0) > 0;
}
