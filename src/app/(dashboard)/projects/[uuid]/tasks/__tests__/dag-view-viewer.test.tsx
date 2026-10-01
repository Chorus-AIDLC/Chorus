// @vitest-environment jsdom
// Viewer mode on the Tasks dependency graph: no connecting / deleting edges.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { ProjectAccessProvider } from "@/contexts/project-access-context";

const flowProps = vi.hoisted(() => ({ last: null as Record<string, unknown> | null }));
vi.mock("@xyflow/react", () => ({
  ReactFlow: (props: Record<string, unknown>) => {
    flowProps.last = props;
    return <div data-testid="flow" />;
  },
  Background: () => null,
  Controls: () => null,
  // One node so the graph (not the empty state) renders.
  useNodesState: () => [[{ id: "t1", position: { x: 0, y: 0 }, data: {} }], vi.fn(), vi.fn()],
  useEdgesState: () => [[], vi.fn(), vi.fn()],
}));
vi.mock("@xyflow/react/dist/style.css", () => ({}));
vi.mock("next-intl", () => ({ useTranslations: () => (k: string) => k }));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock("@/hooks/use-dark-class", () => ({ useDarkClass: () => false }));
vi.mock("../actions", () => ({ getProjectDependenciesAction: vi.fn(async () => ({ nodes: [], edges: [] })) }));
vi.mock("../[taskUuid]/dependency-actions", () => ({ addTaskDependencyAction: vi.fn() }));

import { DagView } from "../dag-view";

async function renderAs(level: "viewer" | "editor") {
  render(
    <ProjectAccessProvider accessLevel={level}>
      <DagView projectUuid="p" onTaskSelect={vi.fn()} />
    </ProjectAccessProvider>,
  );
  await waitFor(() => expect(flowProps.last).not.toBeNull());
  return flowProps.last!;
}

describe("DagView — viewer mode", () => {
  beforeEach(() => { flowProps.last = null; });

  it("viewer: connecting and edge deletion are disabled", async () => {
    const props = await renderAs("viewer");
    expect(props.nodesConnectable).toBe(false);
    expect(props.onConnect).toBeUndefined();
    expect(props.deleteKeyCode).toBeNull();
  });

  it("editor: connecting is enabled", async () => {
    const props = await renderAs("editor");
    expect(props.nodesConnectable).toBe(true);
    expect(typeof props.onConnect).toBe("function");
  });
});
