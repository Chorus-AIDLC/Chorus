// Deterministic in-memory stdio server using the real Writable callback contract.
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";

export function appServerChild({ threadId = "thread-1", turnId = "turn-1", handler, autoComplete = true, closeOnEnd = true } = {}) {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.requests = [];
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.send = (message) => child.stdout.write(JSON.stringify(message) + "\n");
  child.reply = (request, result) => child.send({ id: request.id, result });
  child.terminal = (status = "completed") => child.send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status, items: [] } } });
  child.exit = (code = 0, { close = true } = {}) => {
    if (child.exitCode !== null) return;
    child.exitCode = code;
    child.emit("exit", code);
    if (close) {
      child.stdout.end(); child.stderr.end();
      setImmediate(() => child.emit("close", code));
    }
  };
  child.stdin = new Writable({
    write(chunk, encoding, callback) {
      const request = JSON.parse(chunk.toString());
      child.requests.push(request);
      callback();
      queueMicrotask(() => {
        if (handler?.(request, child) === true) return;
        if (!Object.hasOwn(request, "id") || !request.method) return;
        if (request.method === "initialize") child.reply(request, { userAgent: "test" });
        else if (request.method.startsWith("thread/")) child.reply(request, { thread: { id: threadId } });
        else if (request.method === "turn/start") {
          child.send({ method: "turn/started", params: { threadId, turn: { id: turnId, status: "inProgress" } } });
          child.reply(request, { turn: { id: turnId } });
          if (autoComplete) child.terminal();
        } else if (request.method === "turn/interrupt") { child.reply(request, {}); child.terminal("interrupted"); }
      });
    },
    final(callback) {
      callback();
      if (closeOnEnd) setImmediate(() => child.exit());
    },
  });
  return child;
}
