// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

import { DirectoryBrowser } from "@/components/agent-presence/directory-browser";

const instance = {
  connectionUuid: "connection-1",
  agentInstanceUuid: "instance-1",
  host: "build-host",
  cwd: "/workspace",
  effectiveStatus: "online" as const,
};

describe("DirectoryBrowser", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("does not browse when Enter confirms an active IME composition", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(
      <DirectoryBrowser
        agentUuid="agent-1"
        instances={[instance]}
        onValidated={vi.fn()}
        confirmLabel="Confirm"
      />,
    );

    const input = screen.getByRole("textbox", { name: "pathPrefix" });
    fireEvent.change(input, { target: { value: "/workspace/pro" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("normalizes unknown server error codes before translation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({ success: false, error: { code: "FORBIDDEN" } }),
      }),
    );
    render(
      <DirectoryBrowser
        agentUuid="agent-1"
        instances={[instance]}
        onValidated={vi.fn()}
        confirmLabel="Confirm"
      />,
    );

    const input = screen.getByRole("textbox", { name: "pathPrefix" });
    fireEvent.change(input, { target: { value: "/workspace/pro" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toBe(
        "errors.INTERNAL_ERROR",
      );
    });
  });
});
