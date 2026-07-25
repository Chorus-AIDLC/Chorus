import { describe, expect, it, vi } from "vitest";
import {
  codexUsageMapPath,
  getCodexUsageSnapshot,
  normalizeCodexUsageEvent,
  setCodexUsageSnapshot,
} from "../codex-usage-map.mjs";

const ANCHOR = "11111111-1111-4111-8111-111111111111";
const TID = "019f091a-844e-7b43-8c31-6b04ffa38149";

function fakeFs(initial = {}) {
  const files = { ...initial };
  return {
    files,
    read(path) {
      if (!(path in files)) {
        const err = new Error("missing");
        err.code = "ENOENT";
        throw err;
      }
      return files[path];
    },
    write(path, content) { files[path] = String(content); },
    mkdir() {},
    rename(from, to) { files[to] = files[from]; delete files[from]; },
  };
}

describe("Codex cumulative usage normalization", () => {
  it("converts a resumed cumulative snapshot to exclusive per-turn deltas", () => {
    const previous = {
      input_tokens: 13566,
      cached_input_tokens: 0,
      cache_write_input_tokens: 13564,
      output_tokens: 5,
      reasoning_output_tokens: 0,
    };
    const event = {
      type: "turn.completed",
      usage: {
        input_tokens: 31551,
        cached_input_tokens: 13564,
        cache_write_input_tokens: 17983,
        output_tokens: 10,
        reasoning_output_tokens: 0,
      },
    };
    expect(normalizeCodexUsageEvent(event, previous).usage).toEqual({
      input_tokens: 2,
      cached_input_tokens: 13564,
      cache_write_input_tokens: 4419,
      output_tokens: 5,
      reasoning_output_tokens: 0,
    });
  });

  it("treats a decreased counter as a reset and never emits negatives", () => {
    const event = {
      type: "turn.completed",
      usage: {
        input_tokens: 10,
        cached_input_tokens: 20,
        cache_write_input_tokens: 0,
        output_tokens: 3,
      },
    };
    const result = normalizeCodexUsageEvent(event, {
      input_tokens: 100,
      cached_input_tokens: 50,
      cache_write_input_tokens: 20,
      output_tokens: 9,
    });
    expect(result.usage).toMatchObject({
      input_tokens: 0,
      cached_input_tokens: 20,
      cache_write_input_tokens: 0,
      output_tokens: 3,
    });
  });
});

describe("Codex usage baseline persistence", () => {
  it("round-trips snapshots across calls and binds them to the thread id", () => {
    const io = fakeFs();
    const path = "/cfg/codex-usage.json";
    setCodexUsageSnapshot(ANCHOR, TID, { input_tokens: 12, output_tokens: 3 }, { ...io, path });
    expect(getCodexUsageSnapshot(ANCHOR, TID, { ...io, path })).toEqual({
      input_tokens: 12,
      output_tokens: 3,
    });
    expect(getCodexUsageSnapshot(ANCHOR, "different", { ...io, path })).toBeNull();
  });

  it("uses an atomic sibling rename and degrades on corrupt state", () => {
    const io = fakeFs({ "/cfg/codex-usage.json": "bad json" });
    const rename = vi.fn(io.rename);
    const logger = { warn: vi.fn() };
    setCodexUsageSnapshot(
      ANCHOR,
      TID,
      { input_tokens: 1 },
      { ...io, path: "/cfg/codex-usage.json", rename, logger }
    );
    expect(rename).toHaveBeenCalledWith("/cfg/codex-usage.json.tmp", "/cfg/codex-usage.json");
    expect(logger.warn).toHaveBeenCalled();
  });

  it("stores under the Chorus config directory", () => {
    expect(codexUsageMapPath()).toMatch(/[\\/]\.chorus[\\/]codex-usage\.json$/);
  });
});
