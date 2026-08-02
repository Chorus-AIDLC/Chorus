import { beforeAll } from "vitest";

const nativeProcessKill = process.kill.bind(process);

beforeAll(() => {
  process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
    if (signal === 0) {
      return nativeProcessKill(pid, signal);
    }
    throw new Error(
      `Tests must inject a process-kill mock instead of sending ${String(signal)} to pid ${pid}`,
    );
  }) as typeof process.kill;
});
