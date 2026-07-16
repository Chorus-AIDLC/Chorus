// cli/__tests__/kiro-transcript.test.mjs
// Covers daemon-kiro-backend spec "Kiro transcript reconstructed from the session
// store with a plain-text fallback": store→structured entries with role mapping +
// text-block filtering, child (subagent) session inclusion via parent_session_id,
// malformed-line skip, and the plain-text stdout fallback when the store is
// missing/unparseable. Fixtures use injected readdir/read — no real FS.
//
// Schema verified live against kiro-cli 2.12.1 (see kiro-transcript.mjs header).
import { describe, it, expect, vi } from "vitest";
import {
  reconstructTranscript,
  parseSessionJsonl,
  extractLineText,
  collectSessionChain,
  stripAnsi,
} from "../kiro-transcript.mjs";

const RUN = "540019be-35ec-4740-8880-a6c83f172646";
const CHILD = "203811b1-3831-4f81-9934-0b083a78d133";
const DIR = "/fake/.kiro/sessions/cli";

/** Build one store `.jsonl` line object (as Kiro writes it). */
function line(kind, blocks) {
  return JSON.stringify({ version: "v1", kind, data: { message_id: "m", content: blocks } });
}
const textBlock = (s) => ({ kind: "text", data: s });
const thinkingBlock = (s) => ({ kind: "thinking", data: { text: s } });
const toolUseBlock = () => ({ kind: "toolUse", data: { toolUseId: "t", name: "x", input: {} } });

describe("stripAnsi — clean headless stdout for the plain-text fallback", () => {
  it("removes CSI color codes, the leading '> ' marker, and trims", () => {
    // Mirrors a real headless kiro stdout: color codes + `> ` + the answer.
    const raw = "\x1b[38;5;141m> \x1b[0mHELLO-FROM-KIRO\x1b[0m\n\n";
    expect(stripAnsi(raw)).toBe("HELLO-FROM-KIRO");
  });
  it("removes braille spinner frames", () => {
    expect(stripAnsi("⢀⠀ working⡀⠀ done")).toBe("working done");
  });
  it("collapses 3+ blank lines and tolerates non-string", () => {
    expect(stripAnsi("a\n\n\n\nb")).toBe("a\n\nb");
    expect(stripAnsi(null)).toBe("");
    expect(stripAnsi(undefined)).toBe("");
  });
  it("passes clean text through unchanged (modulo trim)", () => {
    expect(stripAnsi("just plain text")).toBe("just plain text");
  });
});

describe("extractLineText — keep only `text` content blocks", () => {
  it("concatenates text blocks, dropping thinking/toolUse", () => {
    const data = { content: [thinkingBlock("secret plan"), textBlock("hello "), toolUseBlock(), textBlock("world")] };
    expect(extractLineText(data)).toBe("hello world");
  });
  it("returns '' when there is no text block", () => {
    expect(extractLineText({ content: [thinkingBlock("x"), toolUseBlock()] })).toBe("");
  });
  it("tolerates a bare string content and non-object data", () => {
    expect(extractLineText({ content: "bare" })).toBe("bare");
    expect(extractLineText(null)).toBe("");
    expect(extractLineText({})).toBe("");
  });
});

describe("parseSessionJsonl — lines → Claude-dialect envelopes", () => {
  it("maps Prompt→user, AssistantMessage→assistant; drops ToolResults + empty", () => {
    const raw = [
      line("Prompt", [textBlock("你好你是谁")]),
      line("AssistantMessage", [thinkingBlock("plan"), textBlock("I am Kiro.")]),
      line("ToolResults", [{ kind: "toolResult", data: { status: "ok" } }]),
      line("AssistantMessage", [toolUseBlock()]), // no text → dropped
    ].join("\n");
    const entries = parseSessionJsonl(raw);
    expect(entries).toEqual([
      { type: "user", message: { role: "user", content: [{ type: "text", text: "你好你是谁" }] } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "I am Kiro." }] } },
    ]);
  });

  it("skips blank and malformed lines without throwing (logs)", () => {
    const logger = { warn: vi.fn(), info() {}, error() {} };
    const raw = ["", "  ", "{ not json", line("Prompt", [textBlock("ok")])].join("\n");
    const entries = parseSessionJsonl(raw, logger);
    expect(entries).toHaveLength(1);
    expect(entries[0].message.content[0].text).toBe("ok");
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe("collectSessionChain — parent first, then children by creation order", () => {
  const meta = (o) => JSON.stringify(o);
  function fakeStore(files) {
    return {
      dir: DIR,
      readdir: () => Object.keys(files),
      read: (p) => {
        const name = p.slice(DIR.length + 1);
        if (!(name in files)) {
          const e = new Error("ENOENT");
          e.code = "ENOENT";
          throw e;
        }
        return files[name];
      },
    };
  }

  it("includes child sessions matched by parent_session_id, ordered by created_at", () => {
    const files = {
      [`${RUN}.json`]: meta({ session_id: RUN, parent_session_id: null, created_at: "2026-07-14T05:00:00Z" }),
      [`${CHILD}.json`]: meta({ session_id: CHILD, parent_session_id: RUN, created_at: "2026-07-14T05:30:00Z" }),
      ["aaaa1111-0000-4000-8000-000000000000.json"]: meta({
        session_id: "aaaa1111-0000-4000-8000-000000000000",
        parent_session_id: RUN,
        created_at: "2026-07-14T05:10:00Z",
      }),
      // unrelated session (different parent) — must be excluded
      ["bbbb2222-0000-4000-8000-000000000000.json"]: meta({
        session_id: "bbbb2222-0000-4000-8000-000000000000",
        parent_session_id: "someone-else",
      }),
    };
    const chain = collectSessionChain(RUN, fakeStore(files));
    expect(chain.map((c) => c.sessionId)).toEqual([
      RUN,
      "aaaa1111-0000-4000-8000-000000000000", // 05:10 before 05:30
      CHILD,
    ]);
  });

  it("does NOT treat a root session with session_created_reason:subagent as a child (keys on parent_session_id)", () => {
    // The yolo-root case: reason='subagent' but parent_session_id=null.
    const files = {
      [`${RUN}.json`]: meta({ session_id: RUN, parent_session_id: null, session_created_reason: "subagent" }),
    };
    const chain = collectSessionChain(RUN, fakeStore(files));
    expect(chain.map((c) => c.sessionId)).toEqual([RUN]);
  });

  it("returns just the run session when the store dir is unreadable", () => {
    const chain = collectSessionChain(RUN, {
      dir: DIR,
      readdir: () => {
        throw new Error("ENOENT");
      },
      read: () => "",
    });
    expect(chain).toEqual([{ sessionId: RUN, createdAt: 0 }]);
  });
});

describe("reconstructTranscript — end-to-end store → onMessage, with fallback", () => {
  function fakeStore(files) {
    return {
      dir: DIR,
      readdir: () => Object.keys(files),
      read: (p) => {
        const name = p.slice(DIR.length + 1);
        if (!(name in files)) {
          const e = new Error("ENOENT");
          e.code = "ENOENT";
          throw e;
        }
        return files[name];
      },
    };
  }

  it("emits parent then child conversation text as Claude-dialect envelopes", () => {
    const files = {
      [`${RUN}.json`]: JSON.stringify({ session_id: RUN, parent_session_id: null, created_at: "2026-07-14T05:00:00Z" }),
      [`${RUN}.jsonl`]: [
        line("Prompt", [textBlock("run this")]),
        line("AssistantMessage", [thinkingBlock("hmm"), textBlock("done")]),
      ].join("\n"),
      [`${CHILD}.json`]: JSON.stringify({
        session_id: CHILD,
        parent_session_id: RUN,
        created_at: "2026-07-14T05:30:00Z",
      }),
      [`${CHILD}.jsonl`]: [line("AssistantMessage", [textBlock("VERDICT: PASS")])].join("\n"),
    };
    const onMessage = vi.fn();
    reconstructTranscript({ sessionId: RUN, onMessage, ...fakeStore(files) });
    const texts = onMessage.mock.calls.map((c) => c[0].message.content[0].text);
    expect(texts).toEqual(["run this", "done", "VERDICT: PASS"]);
    // roles preserved
    expect(onMessage.mock.calls.map((c) => c[0].type)).toEqual(["user", "assistant", "assistant"]);
  });

  it("falls back to a plain-text stdout entry when the store jsonl is missing", () => {
    const files = {
      // metadata present (so the chain resolves) but NO .jsonl for the run
      [`${RUN}.json`]: JSON.stringify({ session_id: RUN, parent_session_id: null }),
    };
    const onMessage = vi.fn();
    const logger = { warn: vi.fn(), info() {}, error() {} };
    reconstructTranscript({ sessionId: RUN, onMessage, stdout: "plain output here", logger, ...fakeStore(files) });
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage.mock.calls[0][0]).toEqual({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "plain output here" }] },
    });
    expect(logger.warn).toHaveBeenCalled();
  });

  it("emits nothing (no throw) when the store is missing AND stdout is empty", () => {
    const onMessage = vi.fn();
    const logger = { warn: vi.fn(), info() {}, error() {} };
    reconstructTranscript({
      sessionId: RUN,
      onMessage,
      stdout: "   ",
      logger,
      dir: DIR,
      readdir: () => {
        throw new Error("ENOENT");
      },
      read: () => {
        const e = new Error("ENOENT");
        e.code = "ENOENT";
        throw e;
      },
    });
    expect(onMessage).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("is a no-op when onMessage is absent", () => {
    expect(() => reconstructTranscript({ sessionId: RUN, stdout: "x" })).not.toThrow();
  });

  it("headless case: no session persisted → ANSI-styled stdout falls back to ONE clean entry", () => {
    // Reproduces the verified-live daemon path: `chat --no-interactive` writes no
    // store session, so the chain has no jsonl and the ANSI stdout is the transcript.
    const files = { [`${RUN}.json`]: JSON.stringify({ session_id: RUN, parent_session_id: null }) };
    const onMessage = vi.fn();
    reconstructTranscript({
      sessionId: RUN,
      onMessage,
      stdout: "\x1b[38;5;141m> \x1b[0mHELLO-FROM-KIRO\x1b[0m\n\n",
      ...fakeStore(files),
    });
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage.mock.calls[0][0].message.content[0].text).toBe("HELLO-FROM-KIRO");
  });

  it("fires the fallback even when sessionId is empty (no id captured on a headless run)", () => {
    const onMessage = vi.fn();
    reconstructTranscript({
      sessionId: "",
      onMessage,
      stdout: "plain answer",
      dir: DIR,
      readdir: () => {
        throw new Error("ENOENT");
      },
      read: () => {
        const e = new Error("ENOENT");
        e.code = "ENOENT";
        throw e;
      },
    });
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage.mock.calls[0][0].message.content[0].text).toBe("plain answer");
  });

  it("falls back to plain text when the store has only non-text (tool) content", () => {
    const files = {
      [`${RUN}.json`]: JSON.stringify({ session_id: RUN, parent_session_id: null }),
      [`${RUN}.jsonl`]: [line("AssistantMessage", [toolUseBlock()]), line("ToolResults", [])].join("\n"),
    };
    const onMessage = vi.fn();
    reconstructTranscript({ sessionId: RUN, onMessage, stdout: "fallback text", ...fakeStore(files) });
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage.mock.calls[0][0].message.content[0].text).toBe("fallback text");
  });
});
