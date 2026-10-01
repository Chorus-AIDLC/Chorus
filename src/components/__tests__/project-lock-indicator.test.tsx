// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

import { ProjectLockIndicator } from "@/components/project-lock-indicator";

describe("ProjectLockIndicator", () => {
  it("renders a lock with an sr-only label for private projects", () => {
    render(<ProjectLockIndicator visibility="private" />);
    const el = screen.getByTestId("project-lock-indicator");
    expect(el.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(el.querySelector(".sr-only")?.textContent).toBe("projectAccess.privateBadge");
  });

  it.each(["public", undefined, null, "weird"])("renders nothing for visibility=%s", (v) => {
    const { container } = render(<ProjectLockIndicator visibility={v} />);
    expect(container.innerHTML).toBe("");
  });
});
