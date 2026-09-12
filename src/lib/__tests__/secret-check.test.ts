/**
 * Tests for src/lib/secret-check.ts — NEXTAUTH_SECRET placeholder detection
 * and the startup warning (GitHub issue #559).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const mockLogger = vi.hoisted(() => {
  const l = {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  };
  l.child.mockImplementation(() => l);
  return l;
});

vi.mock("@/lib/logger", () => ({ default: mockLogger }));

import {
  KNOWN_INSECURE_SECRETS,
  assessNextAuthSecret,
  warnOnInsecureNextAuthSecret,
} from "@/lib/secret-check";

const EXPECTED_PLACEHOLDERS = [
  "chorus-docker-secret-change-in-production",
  "chorus-local-secret",
  "your-secret-key-change-in-production",
  "change-me-to-a-random-secret",
];

describe("KNOWN_INSECURE_SECRETS", () => {
  it("contains exactly the four documented placeholders", () => {
    expect([...KNOWN_INSECURE_SECRETS].sort()).toEqual([...EXPECTED_PLACEHOLDERS].sort());
  });

  it("has no duplicates", () => {
    expect(new Set(KNOWN_INSECURE_SECRETS).size).toBe(KNOWN_INSECURE_SECRETS.length);
  });
});

describe("assessNextAuthSecret", () => {
  it("returns missing for undefined", () => {
    expect(assessNextAuthSecret(undefined)).toEqual({ status: "missing" });
  });

  it("returns missing for empty string", () => {
    expect(assessNextAuthSecret("")).toEqual({ status: "missing" });
  });

  it.each(EXPECTED_PLACEHOLDERS)("returns known_insecure for placeholder %s", (placeholder) => {
    expect(assessNextAuthSecret(placeholder)).toEqual({
      status: "known_insecure",
      matched: placeholder,
    });
  });

  it("trims surrounding whitespace before matching", () => {
    expect(assessNextAuthSecret("  chorus-local-secret\n")).toEqual({
      status: "known_insecure",
      matched: "chorus-local-secret",
    });
  });

  it("returns ok for a secure value", () => {
    expect(assessNextAuthSecret("Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZg==")).toEqual({
      status: "ok",
    });
  });

  it("does not apply length heuristics (short non-placeholder value is ok)", () => {
    expect(assessNextAuthSecret("abc")).toEqual({ status: "ok" });
  });

  it("does not partially match placeholders", () => {
    expect(assessNextAuthSecret("chorus-local-secret-2")).toEqual({ status: "ok" });
    expect(assessNextAuthSecret("xchorus-local-secret")).toEqual({ status: "ok" });
  });

  it("does not treat whitespace-only as a placeholder", () => {
    // Whitespace-only is a non-empty, non-placeholder value → ok (no heuristics).
    expect(assessNextAuthSecret("   ")).toEqual({ status: "ok" });
  });
});

describe("warnOnInsecureNextAuthSecret", () => {
  const original = process.env.NEXTAUTH_SECRET;

  beforeEach(() => {
    vi.clearAllMocks();
    mockLogger.child.mockImplementation(() => mockLogger);
  });

  afterEach(() => {
    if (original === undefined) {
      delete process.env.NEXTAUTH_SECRET;
    } else {
      process.env.NEXTAUTH_SECRET = original;
    }
  });

  it("logs exactly one error with reason default_secret for a known placeholder", () => {
    process.env.NEXTAUTH_SECRET = "chorus-docker-secret-change-in-production";

    expect(() => warnOnInsecureNextAuthSecret()).not.toThrow();

    expect(mockLogger.child).toHaveBeenCalledWith({ module: "security" });
    expect(mockLogger.error).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn).not.toHaveBeenCalled();

    const [fields, msg] = mockLogger.error.mock.calls[0] as [Record<string, unknown>, string];
    expect(fields).toMatchObject({
      reason: "default_secret",
      matched: "chorus-docker-secret-change-in-production",
    });
    // Message content required by the tech design
    expect(msg).toMatch(/user AND super-admin session JWTs/);
    expect(msg).toMatch(/forge/);
    expect(msg).toContain("openssl rand -base64 32");
    expect(msg).toMatch(/[Rr]otat/);
    expect(msg).toMatch(/invalidates all existing sessions/);
    expect(msg).toMatch(/[Mm]ulti-replica/);
    expect(msg).toMatch(/share one/);
    expect(msg).toContain("#559");
  });

  it("never mutates the placeholder value", () => {
    process.env.NEXTAUTH_SECRET = "chorus-local-secret";
    warnOnInsecureNextAuthSecret();
    expect(process.env.NEXTAUTH_SECRET).toBe("chorus-local-secret");
  });

  it("logs exactly one warn with reason missing_secret when unset", () => {
    delete process.env.NEXTAUTH_SECRET;

    expect(() => warnOnInsecureNextAuthSecret()).not.toThrow();

    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    expect(mockLogger.error).not.toHaveBeenCalled();
    const [fields, msg] = mockLogger.warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(fields).toEqual({ reason: "missing_secret" });
    expect(msg).toContain("NEXTAUTH_SECRET is not set");
    // Never sets a fallback value
    expect(process.env.NEXTAUTH_SECRET).toBeUndefined();
  });

  it("logs exactly one warn when set to empty string", () => {
    process.env.NEXTAUTH_SECRET = "";

    warnOnInsecureNextAuthSecret();

    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    expect(mockLogger.error).not.toHaveBeenCalled();
    expect(process.env.NEXTAUTH_SECRET).toBe("");
  });

  it("logs nothing for a secure value", () => {
    process.env.NEXTAUTH_SECRET = "a-perfectly-fine-random-secret-value-1234567890";

    warnOnInsecureNextAuthSecret();

    expect(mockLogger.child).not.toHaveBeenCalled();
    expect(mockLogger.error).not.toHaveBeenCalled();
    expect(mockLogger.warn).not.toHaveBeenCalled();
    expect(mockLogger.info).not.toHaveBeenCalled();
    expect(mockLogger.debug).not.toHaveBeenCalled();
  });

  it("never throws even if the logger itself throws", () => {
    process.env.NEXTAUTH_SECRET = "chorus-local-secret";
    mockLogger.child.mockImplementation(() => {
      throw new Error("logger exploded");
    });

    expect(() => warnOnInsecureNextAuthSecret()).not.toThrow();
    expect(process.env.NEXTAUTH_SECRET).toBe("chorus-local-secret");
  });
});

describe("parity with docker/ensure-secret.sh and chorus.mjs", () => {
  const SH_PATH = path.resolve(__dirname, "../../../docker/ensure-secret.sh");
  const MJS_PATH = path.resolve(__dirname, "../../../chorus.mjs");

  function parseShPlaceholders(): string[] {
    // Fail clearly (not skip) if the sh file is missing.
    expect(fs.existsSync(SH_PATH), `expected ${SH_PATH} to exist`).toBe(true);
    const source = fs.readFileSync(SH_PATH, "utf8");
    const match = source.match(/^CHORUS_KNOWN_INSECURE_SECRETS="([\s\S]*?)"\s*$/m);
    expect(match, "CHORUS_KNOWN_INSECURE_SECRETS block not found in ensure-secret.sh").not.toBeNull();
    return match![1]
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  function parseMjsPlaceholders(): string[] {
    expect(fs.existsSync(MJS_PATH), `expected ${MJS_PATH} to exist`).toBe(true);
    const source = fs.readFileSync(MJS_PATH, "utf8");
    const match = source.match(/^const KNOWN_INSECURE_SECRETS = \[([\s\S]*?)\];\s*$/m);
    expect(match, "KNOWN_INSECURE_SECRETS array not found in chorus.mjs").not.toBeNull();
    return [...match![1].matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  }

  it("KNOWN_INSECURE_SECRETS is set-equal to CHORUS_KNOWN_INSECURE_SECRETS", () => {
    const shList = parseShPlaceholders();
    expect(shList.length).toBeGreaterThan(0);
    expect(new Set(shList)).toEqual(new Set(KNOWN_INSECURE_SECRETS));
    // Also guard against duplicates on either side
    expect(shList.length).toBe(KNOWN_INSECURE_SECRETS.length);
  });

  it("chorus.mjs KNOWN_INSECURE_SECRETS is set-equal to the TS list (npm launcher parity)", () => {
    const mjsList = parseMjsPlaceholders();
    expect(mjsList.length).toBeGreaterThan(0);
    expect(new Set(mjsList)).toEqual(new Set(KNOWN_INSECURE_SECRETS));
    expect(mjsList.length).toBe(KNOWN_INSECURE_SECRETS.length);
  });

  it("chorus.mjs ensureSecret ignores a placeholder NEXTAUTH_SECRET and warns on stderr naming #559", () => {
    const source = fs.readFileSync(MJS_PATH, "utf8");
    const fnStart = source.indexOf("function ensureSecret()");
    expect(fnStart).toBeGreaterThan(-1);
    const body = source.slice(fnStart, source.indexOf("\n}\n", fnStart));
    expect(body).toContain("KNOWN_INSECURE_SECRETS.includes(");
    expect(body).toContain("console.error(");
    expect(body).toContain("#559");
    // The old unconditional early-return on any non-empty value must be gone.
    expect(body).not.toContain("if (process.env.NEXTAUTH_SECRET) return;");
  });

  it("chorus.mjs ensureSecret refuses a persisted placeholder / empty .secret (structural)", () => {
    const source = fs.readFileSync(MJS_PATH, "utf8");
    const fnStart = source.indexOf("function ensureSecret()");
    const body = source.slice(fnStart, source.indexOf("\n}\n", fnStart));
    // The persisted value must be checked against the placeholder list and the
    // process must exit non-zero — the raw readFileSync(...).trim() must no
    // longer be assigned straight into the env.
    expect(body).not.toContain('process.env.NEXTAUTH_SECRET = readFileSync(secretPath, "utf8").trim();');
    expect(body).toContain("KNOWN_INSECURE_SECRETS.includes(persisted)");
    expect(body).toContain("process.exit(1)");
  });

  /**
   * Behavioural harness for chorus.mjs#ensureSecret. The launcher runs side
   * effects at import, so we lift the KNOWN_INSECURE_SECRETS constant and the
   * ensureSecret function verbatim out of the source and run them in a child
   * node process with `dataDir` pointed at a tmp dir.
   */
  function runMjsEnsureSecret(dataDir: string, env: Record<string, string> = {}) {
    const source = fs.readFileSync(MJS_PATH, "utf8");
    const constMatch = source.match(/^const KNOWN_INSECURE_SECRETS = \[[\s\S]*?\];\s*$/m);
    const fnStart = source.indexOf("function ensureSecret()");
    const fnEnd = source.indexOf("\n}\n", fnStart) + 3;
    expect(constMatch).not.toBeNull();
    expect(fnStart).toBeGreaterThan(-1);
    const script = [
      'import { randomBytes, createHash } from "node:crypto";',
      'import { existsSync, readFileSync, writeFileSync } from "node:fs";',
      'import { join } from "node:path";',
      `const dataDir = ${JSON.stringify(dataDir)};`,
      constMatch![0],
      source.slice(fnStart, fnEnd),
      "ensureSecret();",
      'process.stdout.write("EXPORTED=" + (process.env.NEXTAUTH_SECRET ?? "<unset>"));',
    ].join("\n");
    const scriptPath = path.join(dataDir, "harness.mjs");
    fs.writeFileSync(scriptPath, script);
    const childEnv: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV, PATH: process.env.PATH, ...env };
    return spawnSync(process.execPath, [scriptPath], { env: childEnv, encoding: "utf8" });
  }

  describe("chorus.mjs ensureSecret behaviour (persisted file)", () => {
    let dataDir: string;
    let secretPath: string;
    beforeEach(() => {
      dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chorus-mjs-secret-"));
      secretPath = path.join(dataDir, ".secret");
    });
    afterEach(() => {
      fs.rmSync(dataDir, { recursive: true, force: true });
    });

    for (const placeholder of KNOWN_INSECURE_SECRETS) {
      it(`persisted placeholder "${placeholder}" → exit 1, stderr names #559 + path, nothing exported`, () => {
        fs.writeFileSync(secretPath, `${placeholder}\n`);
        const r = runMjsEnsureSecret(dataDir);
        expect(r.status).toBe(1);
        expect(r.stderr).toContain("#559");
        expect(r.stderr).toContain(secretPath);
        expect(r.stderr).toContain("publicly known placeholder");
        expect(r.stderr.trim().split("\n")).toHaveLength(1);
        expect(r.stdout).not.toContain("EXPORTED=");
        // File is left untouched (no silent regeneration).
        expect(fs.readFileSync(secretPath, "utf8")).toBe(`${placeholder}\n`);
      });
    }

    it("persisted empty / whitespace-only .secret → exit 1, stderr names #559 + path, nothing exported", () => {
      for (const content of ["", "  \n\t"]) {
        fs.writeFileSync(secretPath, content);
        const r = runMjsEnsureSecret(dataDir);
        expect(r.status, JSON.stringify(content)).toBe(1);
        expect(r.stderr).toContain("#559");
        expect(r.stderr).toContain(secretPath);
        expect(r.stderr).toContain("empty");
        expect(r.stdout).not.toContain("EXPORTED=");
      }
    });

    it("persisted placeholder is refused even when env also holds a placeholder", () => {
      fs.writeFileSync(secretPath, KNOWN_INSECURE_SECRETS[0]);
      const r = runMjsEnsureSecret(dataDir, { NEXTAUTH_SECRET: KNOWN_INSECURE_SECRETS[1] });
      expect(r.status).toBe(1);
      expect(r.stdout).not.toContain("EXPORTED=");
    });

    it("persisted secure value → exported trimmed, exit 0", () => {
      const secure = "f".repeat(64);
      fs.writeFileSync(secretPath, `${secure}\n`);
      const r = runMjsEnsureSecret(dataDir);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain(`EXPORTED=${secure}`);
      expect(r.stderr).toBe("");
    });

    it("no persisted file → generates 64-hex with mode 0600 and exports it", () => {
      const r = runMjsEnsureSecret(dataDir);
      expect(r.status, r.stderr).toBe(0);
      const persisted = fs.readFileSync(secretPath, "utf8").trim();
      expect(persisted).toMatch(/^[0-9a-f]{64}$/);
      expect(r.stdout).toContain(`EXPORTED=${persisted}`);
      if (process.platform !== "win32") {
        expect(fs.statSync(secretPath).mode & 0o777).toBe(0o600);
      }
    });

    it("explicit secure env → untouched, no file written", () => {
      const r = runMjsEnsureSecret(dataDir, { NEXTAUTH_SECRET: "a-perfectly-fine-secret" });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain("EXPORTED=a-perfectly-fine-secret");
      expect(fs.existsSync(secretPath)).toBe(false);
    });
  });
});
