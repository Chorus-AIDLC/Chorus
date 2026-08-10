// deriveChatBodyState — the pure body-state derivation extracted from DaemonChat. These
// tests pin the loading-vs-empty-vs-error precedence, the crux of the
// daemon-chat-list-loading-state fix: the conversation list's loading affordance is gated
// on the LIST fetch status alone, so the empty state can never show while the list is still
// loading (the bug was `loading = status === "loading" && listStatus === "loading"`, an AND
// of two independently-settling sources that left a leak window).

import { describe, expect, it } from "vitest";
import { deriveChatBodyState } from "@/components/agent-presence/chat/daemon-chat";

describe("deriveChatBodyState", () => {
  it("first load (listStatus loading, empty) → body with listLoading true (NOT empty)", () => {
    const r = deriveChatBodyState({ listStatus: "loading", sessionCount: 0, agentCount: 0 });
    expect(r.body).toBe("body");
    expect(r.listLoading).toBe(true);
  });

  it("the previously-leaking combo (presence settled, list still loading) → listLoading, not empty", () => {
    // The presence `status` is intentionally NOT an input anymore — listStatus alone drives
    // the loading affordance, so even with agents present and no sessions yet, it's loading.
    const r = deriveChatBodyState({ listStatus: "loading", sessionCount: 0, agentCount: 3 });
    expect(r.listLoading).toBe(true);
    // Not a settled empty → the list pane shows its skeleton, never the no-agents card.
    expect(r.body).toBe("body");
  });

  it("settled empty with agents → normal body (composer), not loading", () => {
    const r = deriveChatBodyState({ listStatus: "ok", sessionCount: 0, agentCount: 2 });
    expect(r.body).toBe("body");
    expect(r.listLoading).toBe(false);
  });

  it("settled empty with NO agents and no history → no-agents card", () => {
    const r = deriveChatBodyState({ listStatus: "ok", sessionCount: 0, agentCount: 0 });
    expect(r.body).toBe("no-agents");
    expect(r.listLoading).toBe(false);
  });

  it("settled with sessions → normal body, not loading", () => {
    const r = deriveChatBodyState({ listStatus: "ok", sessionCount: 5, agentCount: 1 });
    expect(r.body).toBe("body");
    expect(r.listLoading).toBe(false);
  });

  it("error with nothing cached → error card, not empty and not loading", () => {
    const r = deriveChatBodyState({ listStatus: "error", sessionCount: 0, agentCount: 0 });
    expect(r.body).toBe("error");
    expect(r.listLoading).toBe(false);
  });

  it("error but sessions were cached → keep showing the cached body, not the error card", () => {
    const r = deriveChatBodyState({ listStatus: "error", sessionCount: 4, agentCount: 1 });
    expect(r.body).toBe("body");
    expect(r.listLoading).toBe(false);
  });
});
