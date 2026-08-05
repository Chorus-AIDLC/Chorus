// @vitest-environment jsdom

import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const mockGetPmAgentsAction = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/use-progress-router", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

vi.mock("../[ideaUuid]/actions", () => ({
  claimIdeaAction: vi.fn(),
  claimIdeaToAgentAction: vi.fn(),
  claimIdeaToUserAction: vi.fn(),
  releaseIdeaAction: vi.fn(),
  getPmAgentsAction: mockGetPmAgentsAction,
  getAgentInstancesAction: vi.fn(),
}));

vi.mock("next-intl", async () => {
  const en = (await import("../../../../../../../messages/en.json")).default as Record<
    string,
    unknown
  >;

  return {
    useTranslations: () => (key: string) => {
      let value: unknown = en;
      for (const part of key.split(".")) {
        value =
          value && typeof value === "object"
            ? (value as Record<string, unknown>)[part]
            : undefined;
      }
      return typeof value === "string" ? value : key;
    },
  };
});

vi.mock("@/components/ui/scrollable-dialog", () => ({
  ScrollableDialog: ({
    header,
    footer,
    children,
  }: {
    header: React.ReactNode;
    footer: React.ReactNode;
    children: React.ReactNode;
  }) => (
    <div role="dialog">
      {header}
      <div>{children}</div>
      {footer}
    </div>
  ),
  ScrollableDialogTitle: ({ children }: { children: React.ReactNode }) => (
    <h2>{children}</h2>
  ),
}));

import { AssignIdeaModal } from "../assign-idea-modal";

const idea = {
  uuid: "idea-1",
  title: "Verbose Idea title that should not be repeated",
  content: "Verbose Idea description that should not be repeated in the modal.",
  status: "elaborated",
  assignee: {
    type: "agent",
    uuid: "agent-1",
    name: "Admin Claude",
  },
};

describe("AssignIdeaModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetPmAgentsAction.mockResolvedValue({ agents: [], users: [] });
  });

  it("omits repeated Idea copy while preserving assignment context and controls", async () => {
    render(
      <AssignIdeaModal
        idea={idea}
        projectUuid="project-1"
        currentUserUuid="user-1"
        onClose={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Admin Claude")).toBeTruthy();
    });

    expect(screen.queryByText(idea.title)).toBeNull();
    expect(screen.queryByText(idea.content)).toBeNull();
    expect(screen.getByText("Assign to myself")).toBeTruthy();
    expect(screen.getByText("Assign to specific PM Agent")).toBeTruthy();
    expect(screen.getByText("Assign to another user")).toBeTruthy();
    expect(screen.getByText("Release (Clear Assignee)")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Assign" })).toBeTruthy();
  });
});
