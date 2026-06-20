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
import { applyTranscriptEvent } from "@/components/agent-presence/chat/daemon-chat";
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
