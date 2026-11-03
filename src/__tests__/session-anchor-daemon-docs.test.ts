import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const notes = readFileSync(path.resolve(__dirname, "../../docs/DAEMON.md"), "utf8");

describe("daemon session-anchor documentation", () => {
  it.each([
    "task:<taskUuid>",
    "review:task:<taskUuid>",
    "review:proposal:<proposalUuid>",
    "review:idea:<ideaUuid>",
    "Bare direct Idea UUID",
    "Live SSE notifications and reconnect backfill carry the resolved `sessionId`",
    'Legacy execution rows retain `sessionId=""`',
    "An old daemon ignores the new field",
    "When `sessionId` is absent or empty",
    "Native non-CLI consumers",
    "Session separation does **not** isolate",
    "Re-review resumes the same review anchor",
  ])("documents %s", (rule) => {
    expect(notes).toContain(rule);
  });
});
