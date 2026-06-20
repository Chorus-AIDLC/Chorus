// Unit tests for `applyTranscriptEvent` — the pure live-patch function that drives
// the chat-style daemon UI's AC-3 mechanism (子3). It folds a single
// `transcript:{sessionUuid}` SSE event (turn_created / turn_status_changed /
// transcript_appended) into the open conversation's turn list WITHOUT a refetch.
//
// These tests exercise it in isolation (no React / jsdom): each trigger, the
// raced-ahead edge cases (an event for a turn not yet present), message-tail
// de-duplication on a re-delivered append, and immutability (a new array, inputs
// untouched) so React reliably re-renders.

import { describe, expect, it } from "vitest";
import {
  applyTranscriptEvent,
  mergeTurnPage,
} from "@/components/agent-presence/chat/daemon-chat";
import type {
  TranscriptMessageView,
  TurnWithMessagesView,
} from "@/services/daemon-session.service";

function turn(
  overrides: Partial<TurnWithMessagesView> & { uuid: string },
): TurnWithMessagesView {
  return {
    sessionUuid: "s1",
    seq: 1,
    trigger: "task_assigned",
    promptText: null,
    status: "pending",
    executionUuid: null,
    startedAt: null,
    endedAt: null,
    createdAt: "2026-06-16T11:00:00.000Z",
    messages: [],
    ...overrides,
  };
}

function msg(
  overrides: Partial<TranscriptMessageView> & { uuid: string },
): TranscriptMessageView {
  return {
    turnUuid: "t1",
    role: "assistant",
    text: "hello",
    seq: 1,
    createdAt: "2026-06-16T11:01:00.000Z",
    ...overrides,
  };
}

describe("applyTranscriptEvent", () => {
  it("turn_created appends a new band", () => {
    const prev = [turn({ uuid: "t1", seq: 1 })];
    const next = applyTranscriptEvent(prev, {
      trigger: "turn_created",
      turn: turn({ uuid: "t2", seq: 2, status: "running" }),
      messages: [],
    });
    expect(next).toHaveLength(2);
    expect(next[1].uuid).toBe("t2");
    expect(next[1].status).toBe("running");
    expect(next[1].messages).toEqual([]);
  });

  it("turn_created for an already-present turn refreshes fields but keeps messages", () => {
    const prev = [
      turn({ uuid: "t1", status: "pending", messages: [msg({ uuid: "m1" })] }),
    ];
    const next = applyTranscriptEvent(prev, {
      trigger: "turn_created",
      turn: turn({ uuid: "t1", status: "running" }),
      messages: [],
    });
    expect(next).toHaveLength(1);
    expect(next[0].status).toBe("running");
    // Existing messages are preserved (not wiped by the re-create).
    expect(next[0].messages.map((m) => m.uuid)).toEqual(["m1"]);
  });

  it("turn_status_changed patches the band's status in place", () => {
    const prev = [
      turn({ uuid: "t1", status: "pending" }),
      turn({ uuid: "t2", status: "running" }),
    ];
    const next = applyTranscriptEvent(prev, {
      trigger: "turn_status_changed",
      turn: turn({ uuid: "t2", status: "ended", endedAt: "2026-06-16T12:00:00.000Z" }),
      messages: [],
    });
    expect(next).toHaveLength(2);
    expect(next[1].status).toBe("ended");
    expect(next[1].endedAt).toBe("2026-06-16T12:00:00.000Z");
    // Messages and the other turn are untouched.
    expect(next[0].status).toBe("pending");
  });

  it("transcript_appended grows the affected turn's message tail", () => {
    const prev = [turn({ uuid: "t1", messages: [msg({ uuid: "m1", seq: 1 })] })];
    const next = applyTranscriptEvent(prev, {
      trigger: "transcript_appended",
      turn: turn({ uuid: "t1" }),
      messages: [msg({ uuid: "m2", seq: 2, text: "world" })],
    });
    expect(next[0].messages.map((m) => m.uuid)).toEqual(["m1", "m2"]);
    expect(next[0].messages[1].text).toBe("world");
  });

  it("transcript_appended de-dupes a re-delivered message by uuid", () => {
    const prev = [turn({ uuid: "t1", messages: [msg({ uuid: "m1" })] })];
    const next = applyTranscriptEvent(prev, {
      trigger: "transcript_appended",
      turn: turn({ uuid: "t1" }),
      // m1 is re-delivered alongside a genuinely new m2.
      messages: [msg({ uuid: "m1" }), msg({ uuid: "m2", seq: 2 })],
    });
    expect(next[0].messages.map((m) => m.uuid)).toEqual(["m1", "m2"]);
  });

  it("a status-change for a not-yet-present turn materializes it (raced ahead of create)", () => {
    const prev = [turn({ uuid: "t1" })];
    const next = applyTranscriptEvent(prev, {
      trigger: "turn_status_changed",
      turn: turn({ uuid: "t2", status: "running" }),
      messages: [],
    });
    expect(next).toHaveLength(2);
    expect(next[1].uuid).toBe("t2");
    expect(next[1].status).toBe("running");
  });

  it("an append for a not-yet-present turn materializes it with its messages", () => {
    const prev = [turn({ uuid: "t1" })];
    const next = applyTranscriptEvent(prev, {
      trigger: "transcript_appended",
      turn: turn({ uuid: "t2" }),
      messages: [msg({ uuid: "m9", turnUuid: "t2" })],
    });
    expect(next).toHaveLength(2);
    expect(next[1].uuid).toBe("t2");
    expect(next[1].messages.map((m) => m.uuid)).toEqual(["m9"]);
  });

  it("inserts a materialized OLDER turn at its seq position (not blindly at the end)", () => {
    // The loaded window is seq 5-6; an event for seq 3 (a turn older than the page, e.g.
    // a status change for a trimmed/out-of-window turn) must land BEFORE them, preserving
    // ascending order that loadEarlier's `turns[0].seq` cursor + the newest-turn header rely on.
    const prev = [turn({ uuid: "t5", seq: 5 }), turn({ uuid: "t6", seq: 6 })];
    const next = applyTranscriptEvent(prev, {
      trigger: "turn_status_changed",
      turn: turn({ uuid: "t3", seq: 3, status: "ended" }),
      messages: [],
    });
    expect(next.map((t) => t.uuid)).toEqual(["t3", "t5", "t6"]);
    expect(next.map((t) => t.seq)).toEqual([3, 5, 6]);
  });

  it("turn_created inserts by seq when out of order (newest invariant holds)", () => {
    const prev = [turn({ uuid: "t2", seq: 2 }), turn({ uuid: "t4", seq: 4 })];
    const next = applyTranscriptEvent(prev, {
      trigger: "turn_created",
      turn: turn({ uuid: "t3", seq: 3 }),
      messages: [],
    });
    expect(next.map((t) => t.seq)).toEqual([2, 3, 4]);
  });

  it("returns a new array and does not mutate the input (so React re-renders)", () => {
    const prev = [turn({ uuid: "t1", messages: [msg({ uuid: "m1" })] })];
    const snapshotLen = prev[0].messages.length;
    const next = applyTranscriptEvent(prev, {
      trigger: "transcript_appended",
      turn: turn({ uuid: "t1" }),
      messages: [msg({ uuid: "m2", seq: 2 })],
    });
    expect(next).not.toBe(prev);
    expect(next[0]).not.toBe(prev[0]);
    // Original input untouched.
    expect(prev[0].messages).toHaveLength(snapshotLen);
  });
});

describe("mergeTurnPage", () => {
  it("unions two pages by uuid, sorted ascending by seq", () => {
    const earlier = [turn({ uuid: "t1", seq: 1 }), turn({ uuid: "t2", seq: 2 })];
    const current = [turn({ uuid: "t3", seq: 3 }), turn({ uuid: "t4", seq: 4 })];
    const merged = mergeTurnPage(earlier, current);
    expect(merged.map((t) => t.seq)).toEqual([1, 2, 3, 4]);
  });

  it("keeps a live turn that accrued during the fetch (no blind replace loses it)", () => {
    // `existing` holds a live turn (t5) that arrived while the page GET was in flight;
    // the fetched page is t3-t4. The merge must retain t5.
    const live = [turn({ uuid: "t5", seq: 5, status: "running" })];
    const page = [turn({ uuid: "t3", seq: 3 }), turn({ uuid: "t4", seq: 4 })];
    const merged = mergeTurnPage(live, page);
    expect(merged.map((t) => t.uuid)).toEqual(["t3", "t4", "t5"]);
    expect(merged.find((t) => t.uuid === "t5")?.status).toBe("running");
  });

  it("on a uuid in both, takes the incoming turn fields + unions message tails", () => {
    const existing = [turn({ uuid: "t1", seq: 1, status: "running", messages: [msg({ uuid: "m1" })] })];
    const incoming = [turn({ uuid: "t1", seq: 1, status: "ended", messages: [msg({ uuid: "m2", seq: 2 })] })];
    const merged = mergeTurnPage(existing, incoming);
    expect(merged).toHaveLength(1);
    expect(merged[0].status).toBe("ended"); // incoming fields win
    // Both sides' messages are preserved (prev first, then new).
    expect(merged[0].messages.map((m) => m.uuid)).toEqual(["m1", "m2"]);
  });
});
