// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import en from "../../../../messages/en.json";
import ja from "../../../../messages/ja.json";
import ko from "../../../../messages/ko.json";
import zh from "../../../../messages/zh.json";
import { useClientTypeLabel } from "@/components/agent-presence/hooks";

vi.mock("next-intl", async () => {
  const messages = (await import("../../../../messages/en.json")).default as unknown as Record<
    string,
    Record<string, string>
  >;
  return {
    useTranslations: (namespace: string) => (key: string) =>
      messages[namespace]?.[key] ?? `${namespace}.${key}`,
  };
});

describe("useClientTypeLabel", () => {
  it("renders the dsh product label through the shared presence resolver", () => {
    const { result } = renderHook(() => useClientTypeLabel());

    expect(result.current("dsh")).toBe("DeepSeek Harness");
  });

  it("defines clientDsh in every supported locale", () => {
    for (const messages of [en, zh, ja, ko]) {
      expect(messages.agentConnections.clientDsh).toBe("DeepSeek Harness");
    }
  });
});
