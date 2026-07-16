// cli/__tests__/client-args.test.mjs
// Covers daemon-startup-output spec "Per-subcommand help for client commands"
// and the flag surface (--agent / --chorus-only / --verbose / -d + lifecycle
// sub-actions) consumed by the downstream daemon tasks.
import { describe, it, expect } from "vitest";
import {
  parseClientFlags,
  parseDaemonAction,
  DAEMON_ACTIONS,
  daemonHelpText,
  loginHelpText,
} from "../client-args.mjs";

describe("parseClientFlags — existing flags still parse", () => {
  it("parses --url / --api-key (space + = forms) and --yolo", () => {
    expect(parseClientFlags(["--url", "https://x", "--api-key", "cho_k", "--yolo"])).toEqual({
      url: "https://x",
      apiKey: "cho_k",
      yolo: true,
    });
    expect(parseClientFlags(["--url=https://y", "--api-key=cho_z"])).toEqual({
      url: "https://y",
      apiKey: "cho_z",
    });
  });

  it("parses --sigint-timeout (space + = forms)", () => {
    expect(parseClientFlags(["--sigint-timeout", "5000"]).sigintTimeout).toBe("5000");
    expect(parseClientFlags(["--sigint-timeout=7000"]).sigintTimeout).toBe("7000");
  });
});

describe("parseClientFlags — new daemon flags", () => {
  it("parses --agent (space + = forms)", () => {
    expect(parseClientFlags(["--agent", "claude-code"]).agent).toBe("claude-code");
    expect(parseClientFlags(["--agent=codex"]).agent).toBe("codex");
  });

  it("parses boolean --chorus-only / --verbose / -d / --detach / --force", () => {
    expect(parseClientFlags(["--chorus-only"]).chorusOnly).toBe(true);
    expect(parseClientFlags(["--verbose"]).verbose).toBe(true);
    expect(parseClientFlags(["-d"]).detach).toBe(true);
    expect(parseClientFlags(["--detach"]).detach).toBe(true);
    expect(parseClientFlags(["--force"]).force).toBe(true);
  });

  it("parses boolean --yes / -y into yes:true (non-interactive install)", () => {
    expect(parseClientFlags(["--yes"]).yes).toBe(true);
    expect(parseClientFlags(["-y"]).yes).toBe(true);
  });

  it("parses --help / -h into help:true", () => {
    expect(parseClientFlags(["--help"]).help).toBe(true);
    expect(parseClientFlags(["-h"]).help).toBe(true);
  });

  it("leaves unset flags undefined (no accidental defaults)", () => {
    const f = parseClientFlags([]);
    expect(f.yolo).toBeUndefined();
    expect(f.chorusOnly).toBeUndefined();
    expect(f.verbose).toBeUndefined();
    expect(f.detach).toBeUndefined();
    expect(f.agent).toBeUndefined();
    expect(f.force).toBeUndefined();
    expect(f.yes).toBeUndefined();
    expect(f.help).toBeUndefined();
  });

  it("parses a realistic combined invocation", () => {
    expect(
      parseClientFlags(["--agent", "claude-code", "--chorus-only", "--verbose", "-d"])
    ).toEqual({ agent: "claude-code", chorusOnly: true, verbose: true, detach: true });
  });
});

describe("parseDaemonAction — lifecycle sub-actions", () => {
  it("recognizes stop/status/restart/logs as the first positional token", () => {
    expect(parseDaemonAction(["stop"])).toBe("stop");
    expect(parseDaemonAction(["status"])).toBe("status");
    expect(parseDaemonAction(["restart"])).toBe("restart");
    expect(parseDaemonAction(["logs"])).toBe("logs");
  });

  it("defaults to 'run' for no token, a flag token, or an unknown token", () => {
    expect(parseDaemonAction([])).toBe("run");
    expect(parseDaemonAction(["-d"])).toBe("run");
    expect(parseDaemonAction(["--help"])).toBe("run");
    expect(parseDaemonAction(["--url", "https://x"])).toBe("run");
    expect(parseDaemonAction(["bogus"])).toBe("run");
  });

  it("only treats the FIRST token as the action — a flag VALUE matching a verb is not an action", () => {
    // `chorus daemon --url stop` must run the daemon against url "stop", not invoke the stop action.
    expect(parseDaemonAction(["--url", "stop"])).toBe("run");
    expect(parseDaemonAction(["-d", "status"])).toBe("run");
    // A real action still wins when it leads, even with trailing flags.
    expect(parseDaemonAction(["restart", "--verbose"])).toBe("restart");
  });

  it("DAEMON_ACTIONS is exactly the lifecycle + service verbs", () => {
    expect([...DAEMON_ACTIONS].sort()).toEqual(["install", "logs", "restart", "status", "stop", "uninstall"]);
  });

  it("recognizes install / uninstall as leading actions", () => {
    expect(parseDaemonAction(["install"])).toBe("install");
    expect(parseDaemonAction(["install", "--cwd", "/a"])).toBe("install");
    expect(parseDaemonAction(["uninstall"])).toBe("uninstall");
  });
});

describe("daemonHelpText", () => {
  const help = daemonHelpText("9.9.9");

  it("documents every new daemon flag and the lifecycle sub-actions", () => {
    for (const token of [
      "--yolo",
      "--chorus-only",
      "--agent",
      "--verbose",
      "-d",
      "--yes",
      "stop",
      "status",
      "restart",
      "logs",
      "stop --force",
      "install",
      "uninstall",
    ]) {
      expect(help).toContain(token);
    }
  });

  it("identifies itself as daemon help and carries the version", () => {
    expect(help.toLowerCase()).toContain("daemon");
    expect(help).toContain("9.9.9");
  });
});

describe("loginHelpText", () => {
  const help = loginHelpText("9.9.9");

  it("identifies itself as login help and documents --url / --api-key", () => {
    expect(help.toLowerCase()).toContain("login");
    expect(help).toContain("--url");
    expect(help).toContain("--api-key");
    expect(help).toContain("9.9.9");
  });
});
