// Event-level tests for the optional pre-submit gate (CHORUS_SUBMIT_GATE).
// The pure decisions are covered in submit-gate.test.ts; these drive the real
// extension factory to prove the wiring: default off reads nothing, `block`
// returns a block verdict, `warn` notifies instead of blocking, and a fresh
// read clears the gate.

import { expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

process.env.CHORUS_URL = "http://localhost:9999/api/mcp";
process.env.CHORUS_API_KEY = "cho_test_key";

const TASK = "516b3164-768a-4800-8bab-2f8017985a38";

type Handlers = Record<string, (event: unknown, ctx: unknown) => Promise<unknown>>;

interface Harness {
  handlers: Handlers;
  notifies: { msg: string; level: string }[];
}

async function load(mode: string): Promise<Harness> {
  const prior = process.env.CHORUS_SUBMIT_GATE;
  process.env.CHORUS_SUBMIT_GATE = mode;
  try {
    // Distinct module URL per mode: the factory captures the mode at load time.
    const ext = await import(`../extensions/chorus.ts?submitgate=${mode}`);
    const handlers: Handlers = {};
    const notifies: { msg: string; level: string }[] = [];
    ext.default({
      on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => {
        handlers[event] = handler;
      },
      events: { on: () => {}, emit: () => {} },
      sendUserMessage: () => {},
    } as unknown as ExtensionAPI);
    return { handlers, notifies };
  } finally {
    if (prior === undefined) delete process.env.CHORUS_SUBMIT_GATE;
    else process.env.CHORUS_SUBMIT_GATE = prior;
  }
}

function ctxFor(notifies: { msg: string; level: string }[]) {
  return {
    ui: {
      notify: (msg: string, level: string) => notifies.push({ msg, level }),
    },
  };
}

test("default off: the gate never reads event.input", async () => {
  const { handlers } = await load("off");
  let reads = 0;
  const event = {
    toolName: "chorus_submit_for_verify",
    toolCallId: "tc-off",
    isError: false,
    get input(): never {
      reads += 1;
      throw new Error("gate must not read input when off");
    },
  };
  await handlers["tool_call"](event, ctxFor([]));
  await handlers["tool_result"](event, ctxFor([]));
  expect(reads).toBe(0);
});

test("block: submitting without a fresh read is blocked", async () => {
  const { handlers } = await load("block");
  const verdict = (await handlers["tool_call"](
    { toolName: "chorus_submit_for_verify", toolCallId: "tc-b1", isError: false, input: { taskUuid: TASK } },
    ctxFor([]),
  )) as { block?: boolean; reason?: string } | undefined;
  expect(verdict?.block).toBe(true);
  expect(verdict?.reason).toContain("no fresh status read");
});

test("block: a successful read after the last mutation clears it", async () => {
  const { handlers } = await load("block");
  await handlers["tool_call"](
    { toolName: "chorus_claim_task", toolCallId: "tc-c1", isError: false, input: { taskUuid: TASK } },
    ctxFor([]),
  );
  await handlers["tool_call"](
    { toolName: "chorus_get_task", toolCallId: "tc-r1", isError: false, input: { taskUuid: TASK } },
    ctxFor([]),
  );
  await handlers["tool_result"](
    { toolName: "chorus_get_task", toolCallId: "tc-r1", isError: false, input: { taskUuid: TASK }, content: [] },
    ctxFor([]),
  );
  const verdict = await handlers["tool_call"](
    { toolName: "chorus_submit_for_verify", toolCallId: "tc-b2", isError: false, input: { taskUuid: TASK } },
    ctxFor([]),
  );
  expect(verdict).toBeUndefined();
});

test("block: reporting to_verify first is blocked with the specific reason", async () => {
  const { handlers } = await load("block");
  await handlers["tool_call"](
    {
      toolName: "chorus_update_task",
      toolCallId: "tc-u1",
      isError: false,
      input: { taskUuid: TASK, status: "to_verify" },
    },
    ctxFor([]),
  );
  const verdict = (await handlers["tool_call"](
    { toolName: "chorus_submit_for_verify", toolCallId: "tc-b3", isError: false, input: { taskUuid: TASK } },
    ctxFor([]),
  )) as { block?: boolean; reason?: string } | undefined;
  expect(verdict?.block).toBe(true);
  expect(verdict?.reason).toContain("in_progress");
});

test("warn: notifies instead of blocking", async () => {
  const { handlers } = await load("warn");
  const notifies: { msg: string; level: string }[] = [];
  const verdict = await handlers["tool_call"](
    { toolName: "chorus_pm_submit_proposal", toolCallId: "tc-w1", isError: false, input: { proposalUuid: TASK } },
    ctxFor(notifies),
  );
  expect(verdict).toBeUndefined();
  expect(notifies).toHaveLength(1);
  expect(notifies[0].level).toBe("warning");
  expect(notifies[0].msg).toContain("no validate receipt");
});
