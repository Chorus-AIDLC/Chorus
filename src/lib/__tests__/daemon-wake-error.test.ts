import { describe, expect, it } from "vitest";
import { normalizeWakeError, wakeErrorSchema } from "../daemon-wake-error";

const diagnostic = { kind: "execution", source: "claude", message: "Model unavailable" };

describe("daemon wake error boundary", () => {
  it("normalizes absent optional fields while retaining exit code zero", () => {
    expect(normalizeWakeError({ ...diagnostic, exitCode: 0 })).toEqual({
      ...diagnostic, details: null, exitCode: 0, signal: null,
    });
  });

  it.each([
    null, undefined, {}, { ...diagnostic, message: " " },
    { ...diagnostic, source: "unknown" }, { ...diagnostic, kind: "tool" },
    { ...diagnostic, exitCode: 1.5 }, { ...diagnostic, extra: "unexpected" },
    { ...diagnostic, message: "x".repeat(501) },
    { ...diagnostic, details: "x".repeat(8001) },
    { ...diagnostic, signal: "x".repeat(51) },
    { ...diagnostic, message: " ".repeat(500) + "failure" },
    { ...diagnostic, signal: " ".repeat(50) + "SIGKILL" },
    { ...diagnostic, message: "failure" + " ".repeat(500) },
    { ...diagnostic, signal: "SIGKILL" + " ".repeat(50) },
  ])("projects malformed or historical values to null", (raw) => {
    expect(normalizeWakeError(raw)).toBeNull();
  });

  it("accepts exact size boundaries and rejects oversized reports rather than truncating admission", () => {
    expect(wakeErrorSchema.safeParse({
      ...diagnostic, message: "x".repeat(500), details: "x".repeat(8000), signal: "s".repeat(50),
    }).success).toBe(true);
  });

  it("removes terminal control output and known authorization credentials", () => {
    const result = normalizeWakeError({
      ...diagnostic,
      message: "\u001b[31mFailed\u001b[0m: cho_fixture-key",
      details: "\u001b]0;terminal-title\u0007Authorization: Bearer provider.token\u0000\nRetry later",
    });
    expect(result?.message).toBe("Failed: [redacted]");
    expect(result?.details).toBe("Authorization: Bearer [redacted]\nRetry later");
  });

  it("keeps markup as inert data for the plain-text renderer", () => {
    expect(normalizeWakeError({ ...diagnostic, details: "<script>alert(1)</script>" })?.details)
      .toBe("<script>alert(1)</script>");
  });
});
