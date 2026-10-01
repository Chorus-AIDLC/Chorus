// @vitest-environment jsdom
// Viewer (read-only) mode on project pages: create / edit affordances are
// hidden for accessLevel "viewer" and present for editors (and by default).
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  ProjectAccessProvider,
  type ProjectAccessLevel,
} from "@/contexts/project-access-context";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/hooks/use-progress-router", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));
vi.mock("@/hooks/use-panel-url", () => ({
  usePanelUrl: () => ({ selectedId: null, openPanel: vi.fn(), closePanel: vi.fn() }),
}));
vi.mock("@/components/proposal-filter", () => ({ ProposalFilter: () => null }));
vi.mock("../tasks/kanban-board", () => ({ KanbanBoard: () => <div data-testid="kanban" /> }));
vi.mock("../tasks/dag-view", () => ({ DagView: () => null }));
vi.mock("../tasks/task-detail-panel", () => ({ TaskDetailPanel: () => null }));
vi.mock("../documents/actions", () => ({ createDocumentAction: vi.fn() }));
vi.mock("../documents/[documentUuid]/actions", () => ({ updateDocumentAction: vi.fn() }));
vi.mock("@/components/markdown-content", () => ({
  MarkdownContent: ({ children }: { children: string }) => <div>{children}</div>,
}));

import { TaskViewToggle } from "../tasks/task-view-toggle";
import { CreateDocumentDialog } from "../documents/create-document-dialog";
import { DocumentContent } from "../documents/[documentUuid]/document-content";
import { ProjectReadOnlyBanner } from "@/components/project-read-only-banner";

function withLevel(level: ProjectAccessLevel | null, node: React.ReactNode) {
  return level ? <ProjectAccessProvider accessLevel={level}>{node}</ProjectAccessProvider> : node;
}

const cases: [string, ProjectAccessLevel | null, boolean][] = [
  ["viewer", "viewer", false],
  ["editor", "editor", true],
  ["admin", "admin", true],
  ["no provider (default editor)", null, true],
];

describe.each(cases)("project affordances for %s", (_label, level, visible) => {
  it(`${visible ? "shows" : "hides"} the New Task button`, () => {
    render(
      withLevel(
        level,
        <TaskViewToggle projectUuid="p1" initialTasks={[]} currentUserUuid="u1" />,
      ),
    );
    expect(screen.getByTestId("kanban")).toBeTruthy();
    expect(!!screen.queryByRole("button", { name: "tasks.newTask" })).toBe(visible);
  });

  it(`${visible ? "shows" : "hides"} the New Document trigger`, () => {
    render(withLevel(level, <CreateDocumentDialog projectUuid="p1" />));
    expect(!!screen.queryByRole("button", { name: "documents.newDocument" })).toBe(visible);
  });

  it(`${visible ? "shows" : "hides"} the document Edit button`, () => {
    render(
      withLevel(
        level,
        <DocumentContent documentUuid="d1" projectUuid="p1" initialContent="Body text" />,
      ),
    );
    expect(screen.getByText("Body text")).toBeTruthy();
    expect(!!screen.queryByRole("button", { name: "common.edit" })).toBe(visible);
  });

  it(`${visible ? "hides" : "shows"} the read-only banner`, () => {
    render(withLevel(level, <ProjectReadOnlyBanner />));
    const banner = screen.queryByTestId("project-read-only-banner");
    expect(!!banner).toBe(!visible);
    if (banner) expect(banner.textContent).toBe("projectAccess.viewerBanner");
  });
});
