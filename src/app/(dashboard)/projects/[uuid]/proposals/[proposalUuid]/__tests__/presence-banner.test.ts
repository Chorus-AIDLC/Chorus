import { describe, it, expect } from "vitest";

// Test the presence banner rendering logic
// The banner shows when presenceList.length > 0, hides when empty

interface PresenceEntry {
  agentName: string;
  action: "view" | "mutate";
}

function shouldShowBanner(presenceList: PresenceEntry[]): boolean {
  return presenceList.length > 0;
}

function formatAgentNames(presenceList: PresenceEntry[]): string {
  return presenceList.map(p => p.agentName).join(", ");
}

describe("Presence Banner logic", () => {
  it("shows banner when agents are present", () => {
    const presenceList = [{ agentName: "PM Agent", action: "mutate" as const }];
    expect(shouldShowBanner(presenceList)).toBe(true);
  });

  it("hides banner when no agents present", () => {
    expect(shouldShowBanner([])).toBe(false);
  });

  it("formats single agent name", () => {
    const presenceList = [{ agentName: "PM Agent", action: "mutate" as const }];
    expect(formatAgentNames(presenceList)).toBe("PM Agent");
  });

  it("formats multiple agent names with comma", () => {
    const presenceList = [
      { agentName: "PM Agent", action: "mutate" as const },
      { agentName: "Admin Claude", action: "view" as const },
    ];
    expect(formatAgentNames(presenceList)).toBe("PM Agent, Admin Claude");
  });

  it("handles three agents", () => {
    const presenceList = [
      { agentName: "A", action: "mutate" as const },
      { agentName: "B", action: "view" as const },
      { agentName: "C", action: "mutate" as const },
    ];
    expect(formatAgentNames(presenceList)).toBe("A, B, C");
    expect(shouldShowBanner(presenceList)).toBe(true);
  });
});
