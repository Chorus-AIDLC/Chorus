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

// Message-level pagination scenarios (子 — composite-cursor extraction). These exercise
// the SAME uuid-keyed `mergeTurnPage` / `applyTranscriptEvent` under the new pager's
// realities: a single turn split across pages (partial bands), the synthetic `seq=0`
// promptText slot (`uuid: "synthetic:{turnUuid}"`) returned in EVERY page that reaches
// the turn, an empty placeholder band (a trimmed prompt-less turn → empty rendered
// `messages[]`), and a live `transcript_appended` interleaved with a paged load. The
// frontend functions are unchanged; these tests assert they already tolerate the new shape.
describe("message-level pagination — partial-turn bands stitched across pages", () => {
  it("stitches a partial-turn band across two load-earlier pages (newest page first)", () => {
    // First paint returned only the NEWEST messages of a heavy turn t7 (m3, m4); the older
    // load-earlier page returns the SAME turn's earlier messages (m1, m2). mergeTurnPage is
    // called `(incomingOlder, prev)` in loadEarlier — the older page is the "existing" arg —
    // so the band must end up with m1..m4 in ascending order, not duplicated.
    const firstPaint = [turn({ uuid: "t7", seq: 7, messages: [msg({ uuid: "m3", seq: 3 }), msg({ uuid: "m4", seq: 4 })] })];
    const olderPage = [turn({ uuid: "t7", seq: 7, messages: [msg({ uuid: "m1", seq: 1 }), msg({ uuid: "m2", seq: 2 })] })];
    // loadEarlier merges as mergeTurnPage(olderPage, firstPaint): older is "existing", first paint "incoming".
    const merged = mergeTurnPage(olderPage, firstPaint);
    expect(merged).toHaveLength(1);
    expect(merged[0].uuid).toBe("t7");
    // Older messages first (existing), then the newer page's messages appended — m1..m4.
    expect(merged[0].messages.map((m) => m.uuid)).toEqual(["m1", "m2", "m3", "m4"]);
  });

  it("does not duplicate a message that overlaps the two pages of the same turn", () => {
    // A boundary message (m2) appears in BOTH pages (an overlapping fetch). It de-dupes by uuid.
    const olderPage = [turn({ uuid: "t7", seq: 7, messages: [msg({ uuid: "m1", seq: 1 }), msg({ uuid: "m2", seq: 2 })] })];
    const newerPage = [turn({ uuid: "t7", seq: 7, messages: [msg({ uuid: "m2", seq: 2 }), msg({ uuid: "m3", seq: 3 })] })];
    const merged = mergeTurnPage(olderPage, newerPage);
    expect(merged[0].messages.map((m) => m.uuid)).toEqual(["m1", "m2", "m3"]);
  });
});

describe("message-level pagination — synthetic seq=0 slot de-dupe", () => {
  function syntheticMsg(turnUuid: string, text: string): TranscriptMessageView {
    // Mirrors the server's projection: a promptText turn's slot is a RENDERED message with
    // uuid `synthetic:{turnUuid}`, role user, seq 0, text = promptText.
    return {
      uuid: `synthetic:${turnUuid}`,
      turnUuid,
      role: "user",
      text,
      seq: 0,
      createdAt: "2026-06-16T11:00:00.000Z",
    };
  }

  it("de-dupes the synthetic promptText slot by uuid across an overlapping fetch", () => {
    // A human_instruction turn t4's `seq=0` synthetic message is returned in BOTH the
    // first-paint page and a load-earlier page that reaches the same turn. Merging must not
    // render the prompt twice.
    const synth = syntheticMsg("t4", "do the thing");
    const firstPaint = [
      turn({ uuid: "t4", seq: 4, trigger: "human_instruction", promptText: "do the thing", messages: [synth, msg({ uuid: "m1", seq: 1 })] }),
    ];
    const olderPage = [
      turn({ uuid: "t4", seq: 4, trigger: "human_instruction", promptText: "do the thing", messages: [synth] }),
    ];
    const merged = mergeTurnPage(olderPage, firstPaint);
    expect(merged).toHaveLength(1);
    // The synthetic slot appears exactly once, ahead of the real seq>=1 message.
    expect(merged[0].messages.map((m) => m.uuid)).toEqual(["synthetic:t4", "m1"]);
    expect(merged[0].messages.filter((m) => m.uuid === "synthetic:t4")).toHaveLength(1);
  });

  it("a live transcript_appended carrying the synthetic slot again does not double-render it", () => {
    const synth = syntheticMsg("t4", "do the thing");
    const prev = [
      turn({ uuid: "t4", seq: 4, trigger: "human_instruction", promptText: "do the thing", messages: [synth] }),
    ];
    const next = applyTranscriptEvent(prev, {
      trigger: "transcript_appended",
      turn: turn({ uuid: "t4", seq: 4 }),
      // The append re-delivers the synthetic slot alongside a genuinely new real message.
      messages: [synth, msg({ uuid: "m1", seq: 1, turnUuid: "t4" })],
    });
    expect(next[0].messages.map((m) => m.uuid)).toEqual(["synthetic:t4", "m1"]);
  });
});

describe("message-level pagination — empty placeholder band", () => {
  it("renders an empty-band (placeholder) turn without error and merges it by uuid", () => {
    // A prompt-less turn whose real messages were all trimmed comes back as a band with an
    // empty rendered messages[] (the server's placeholder-only slot). It must merge in
    // order and not throw.
    const firstPaint = [turn({ uuid: "t8", seq: 8, messages: [msg({ uuid: "m9", seq: 1 })] })];
    const olderPage = [turn({ uuid: "t6", seq: 6, trigger: "agent_wake", promptText: null, messages: [] })];
    const merged = mergeTurnPage(olderPage, firstPaint);
    expect(merged.map((t) => t.uuid)).toEqual(["t6", "t8"]);
    // The empty band survives with an empty rendered list — not dropped, no error.
    expect(merged[0].messages).toEqual([]);
  });

  it("an empty-band turn arriving via applyTranscriptEvent renders without error", () => {
    const prev = [turn({ uuid: "t8", seq: 8, messages: [msg({ uuid: "m9", seq: 1 })] })];
    const next = applyTranscriptEvent(prev, {
      trigger: "turn_created",
      turn: turn({ uuid: "t9", seq: 9, trigger: "agent_wake", promptText: null }),
      messages: [],
    });
    expect(next.map((t) => t.uuid)).toEqual(["t8", "t9"]);
    expect(next[1].messages).toEqual([]);
  });
});

describe("message-level pagination — live append during paging", () => {
  it("a live transcript_appended during a load-earlier does not double-render the message", () => {
    // Simulate the loadEarlier flow interleaved with a live SSE append on the NEWEST turn.
    // 1) Initial window: t7 with m3,m4 (newest page).
    let turns: TurnWithMessagesView[] = [
      turn({ uuid: "t7", seq: 7, status: "running", messages: [msg({ uuid: "m3", seq: 3 }), msg({ uuid: "m4", seq: 4 })] }),
    ];
    // 2) A live append lands on t7 (m5) WHILE the older fetch is in flight.
    turns = applyTranscriptEvent(turns, {
      trigger: "transcript_appended",
      turn: turn({ uuid: "t7", seq: 7 }),
      messages: [msg({ uuid: "m5", seq: 5, turnUuid: "t7" })],
    });
    expect(turns[0].messages.map((m) => m.uuid)).toEqual(["m3", "m4", "m5"]);
    // 3) The older page resolves with t7's earlier messages (m1, m2) — merge older-as-existing.
    const olderPage = [turn({ uuid: "t7", seq: 7, messages: [msg({ uuid: "m1", seq: 1 }), msg({ uuid: "m2", seq: 2 })] })];
    turns = mergeTurnPage(olderPage, turns);
    // The live m5 is retained, the older m1/m2 are stitched in, nothing double-rendered.
    expect(turns).toHaveLength(1);
    expect(turns[0].messages.map((m) => m.uuid)).toEqual(["m1", "m2", "m3", "m4", "m5"]);
  });

  it("a live append re-delivered after a paged load de-dupes by uuid (no double-render)", () => {
    // The older page already carried m2; a redundant live append re-delivers m2. De-duped.
    let turns: TurnWithMessagesView[] = [
      turn({ uuid: "t7", seq: 7, messages: [msg({ uuid: "m1", seq: 1 }), msg({ uuid: "m2", seq: 2 })] }),
    ];
    turns = applyTranscriptEvent(turns, {
      trigger: "transcript_appended",
      turn: turn({ uuid: "t7", seq: 7 }),
      messages: [msg({ uuid: "m2", seq: 2, turnUuid: "t7" })],
    });
    expect(turns[0].messages.map((m) => m.uuid)).toEqual(["m1", "m2"]);
  });
});
