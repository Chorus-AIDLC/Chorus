// Event-level tests for the optional pre-submit gate (CHORUS_SUBMIT_GATE).
// Pure decisions live in submit-gate.test.ts; these drive the real extension
// factory to prove the wiring: default off reads nothing, `block` returns a block
// verdict, `warn` notifies instead of blocking, a fresh read clears the gate, the
// report-work failure is caught, and submitting consumes the receipt.

import { expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

process.env.CHORUS_URL = "http://localhost:9999/api/mcp";
process.env.CHORUS_API_KEY = "cho_test_key";

const TASK = "b495ba86-8307-4d29-83da-76c674f8ec47";
const PROPOSAL = "6ea98a99-9c91-48ff-8c17-130efb300ced";

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
  return { ui: { notify: (msg: string, level: string) => notifies.push({ msg, level }) } };
}

let idSeq = 0;

async function call(
  h: Harness,
  toolName: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  const toolCallId = `tc-${++idSeq}`;
  const result = await h.handlers["tool_call"]({ toolName, toolCallId, isError: false, input }, ctxFor(h.notifies));
  return result;
}

async function callWithResult(
  h: Harness,
  toolName: string,
  input: Record<string, unknown>,
  text: string,
): Promise<unknown> {
  const toolCallId = `tc-${++idSeq}`;
  const verdict = await h.handlers["tool_call"](
    { toolName, toolCallId, isError: false, input },
    ctxFor(h.notifies),
  );
  await h.handlers["tool_result"](
    { toolName, toolCallId, isError: false, input, content: [{ type: "text", text }] },
    ctxFor(h.notifies),
  );
  return verdict;
}

test("default off: the gate never reads event.input", async () => {
  const h = await load("off");
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
  await h.handlers["tool_call"](event, ctxFor(h.notifies));
  // Built separately on purpose: spreading `event` would evaluate the getter.
  const resultEvent = {
    toolName: "chorus_submit_for_verify",
    toolCallId: "tc-off",
    isError: false,
    content: [],
    get input(): never {
      reads += 1;
      throw new Error("gate must not read input when off");
    },
  };
  await h.handlers["tool_result"](resultEvent, ctxFor(h.notifies));
  expect(reads).toBe(0);
});

test("block: submitting without a fresh read is blocked", async () => {
  const h = await load("block");
  const verdict = (await call(h, "chorus_submit_for_verify", { taskUuid: TASK })) as
    | { block?: boolean; reason?: string }
    | undefined;
  expect(verdict?.block).toBe(true);
  expect(verdict?.reason).toContain("no fresh status read");
});

test("block: a successful read clears it, and the submit consumes the receipt", async () => {
  const h = await load("block");
  await callWithResult(h, "chorus_get_task", { taskUuid: TASK }, JSON.stringify({ status: "in_progress" }));
  expect(await call(h, "chorus_submit_for_verify", { taskUuid: TASK })).toBeUndefined();
  const second = (await call(h, "chorus_submit_for_verify", { taskUuid: TASK })) as
    | { block?: boolean }
    | undefined;
  expect(second?.block).toBe(true);
});

// The original failure: report_work(status=to_verify) after a read, then submit.
test("block: a status-changing report_work invalidates the read receipt", async () => {
  const h = await load("block");
  await callWithResult(h, "chorus_get_task", { taskUuid: TASK }, JSON.stringify({ status: "in_progress" }));
  await call(h, "chorus_report_work", { taskUuid: TASK, report: "done", status: "to_verify" });
  const verdict = (await call(h, "chorus_submit_for_verify", { taskUuid: TASK })) as
    | { block?: boolean; reason?: string }
    | undefined;
  expect(verdict?.block).toBe(true);
  expect(verdict?.reason).toContain("in_progress");
});

test("block: a read reporting to_verify blocks on the status alone", async () => {
  const h = await load("block");
  await callWithResult(h, "chorus_get_task", { taskUuid: TASK }, JSON.stringify({ status: "to_verify" }));
  const verdict = (await call(h, "chorus_submit_for_verify", { taskUuid: TASK })) as
    | { block?: boolean; reason?: string }
    | undefined;
  expect(verdict?.block).toBe(true);
  expect(verdict?.reason).toContain('reported status "to_verify"');
});

test("warn: notifies instead of blocking", async () => {
  const h = await load("warn");
  const verdict = await call(h, "chorus_pm_submit_proposal", { proposalUuid: PROPOSAL });
  expect(verdict).toBeUndefined();
  expect(h.notifies).toHaveLength(1);
  expect(h.notifies[0].level).toBe("warning");
  expect(h.notifies[0].msg).toContain("no chorus_pm_validate_proposal receipt");
});
