// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import messages from "../../../messages/en.json";
import { ProjectAccessProvider } from "@/contexts/project-access-context";

vi.mock("@/hooks/use-progress-router", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/app/(dashboard)/projects/[uuid]/ideas/[ideaUuid]/elaboration-actions", () => ({
  submitElaborationAnswersAction: vi.fn(),
}));

import { ElaborationPanel } from "@/components/elaboration-panel";

const elaboration = {
  summary: { totalQuestions: 1, answeredQuestions: 0, validatedRounds: 0, pendingRound: 1 },
  rounds: [{
    uuid: "r1", roundNumber: 1, status: "pending_answers", isAppended: false,
    questions: [{ uuid: "q1", questionId: "q1", text: "Which levels?", category: "functional", required: true,
      options: [{ id: "a", label: "Three" }, { id: "b", label: "Two" }], answer: null, issue: null }],
  }],
} as never;

function renderAs(level: "viewer" | "editor") {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <ProjectAccessProvider accessLevel={level}>
        <ElaborationPanel ideaUuid="i1" elaboration={elaboration} />
      </ProjectAccessProvider>
    </NextIntlClientProvider>,
  );
}

describe("ElaborationPanel — viewer mode", () => {
  it("shows pending questions read-only (no answer options / submit) for a viewer", () => {
    renderAs("viewer");
    expect(screen.getByText(messages.projectAccess.elaborationReadOnly)).toBeTruthy();
    expect(screen.getByText("Which levels?")).toBeTruthy();
    expect(screen.queryByText("Three")).toBeNull();
  });

  it("keeps the answer form for an editor", () => {
    renderAs("editor");
    expect(screen.queryByText(messages.projectAccess.elaborationReadOnly)).toBeNull();
    expect(screen.getByText("Three")).toBeTruthy();
  });
});
