// @vitest-environment jsdom

import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FixedCwdAnchor } from "@/components/agent-presence/fixed-cwd-anchor";

vi.mock("next/navigation", () => ({
  useParams: () => ({ uuid: "project-1" }),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

describe("FixedCwdAnchor", () => {
  it("renders the immutable host/cwd anchor and project settings link", () => {
    render(
      <FixedCwdAnchor
        target={{
          actorUserUuid: "user-1",
          agentUuid: "agent-1",
          source: "project_fixed",
          host: "build-host",
          cwd: "/workspace/chorus",
          availability: "offline",
          promptPolicy: "suppress",
          connectionUuid: null,
          agentInstanceUuid: "instance-1",
        }}
      />,
    );

    expect(screen.getByRole("region", { name: "title" })).toBeTruthy();
    expect(screen.getByText("build-host")).toBeTruthy();
    expect(screen.getByText("/workspace/chorus")).toBeTruthy();
    expect(screen.getByText("availability.offline")).toBeTruthy();
    expect(screen.getByRole("link", { name: "manage" }).getAttribute("href")).toBe(
      "/projects/project-1/dashboard?settings=agent-cwds",
    );
    expect(screen.queryByRole("button")).toBeNull();
  });
});
