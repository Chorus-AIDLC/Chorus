/**
 * Tests for src/lib/secret-check.ts — NEXTAUTH_SECRET placeholder detection
 * and the startup warning (GitHub issue #559).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

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

describe("parity with docker/ensure-secret.sh", () => {
  const SH_PATH = path.resolve(__dirname, "../../../docker/ensure-secret.sh");

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

  it("KNOWN_INSECURE_SECRETS is set-equal to CHORUS_KNOWN_INSECURE_SECRETS", () => {
    const shList = parseShPlaceholders();
    expect(shList.length).toBeGreaterThan(0);
    expect(new Set(shList)).toEqual(new Set(KNOWN_INSECURE_SECRETS));
    // Also guard against duplicates on either side
    expect(shList.length).toBe(KNOWN_INSECURE_SECRETS.length);
  });
});
