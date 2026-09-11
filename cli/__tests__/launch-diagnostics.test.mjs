import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { redactedSetupError } from "../launch-diagnostics.mjs";
import { prepareManagedDshConfig } from "../dsh-managed-config.mjs";
import { DshSpawner } from "../dsh-spawner.mjs";

const secrets = [
  'private-quote"secret', "private-backslash\\secret", "private-newline\nsecret",
  "private-tab\tsecret", "private-return\rsecret", "private-backspace\bsecret",
  "private-formfeed\fsecret", "private-controls\x01\x1b\x7fsecret", "private-unicode雪secret",
];
const formats = [
  ["raw", (value) => value],
  ["JSON escaped fragment", (value) => JSON.stringify(value).slice(1, -1)],
  ["JSON string", (value) => JSON.stringify(value)],
  ["formatted JSON string value", (value) => JSON.stringify({ value }, null, 2)],
  ["nested JSON error", (value) => JSON.stringify({ error: JSON.stringify({ message: value }) }, null, 2)],
  ["deeply escaped wrapper", (value) => {
    for (let i = 0; i < 16; i++) value = JSON.stringify({ error: value });
    return value;
  }],
  ["unicode escapes", (value) => [...value].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`).join("")],
  ["URI wrapper", (value) => encodeURIComponent(JSON.stringify({ message: value }))],
  ["base64 wrapper", (value) => Buffer.from(JSON.stringify({ error: value })).toString("base64")],
];
const versionHint = "version mismatch; check dsh runtime and Chorus bundle compatibility";
const adapterHint = "no adapter registered; check that the selected provider adapter is installed";
const fallback = "unclassified setup failure; check dsh installation, sdk profile, provider adapter, package registry and filesystem permissions (raw details withheld)";

function assertNoPayload(output, values, format) {
  for (const value of values) {
    expect(output).not.toContain(value);
    expect(output).not.toContain(format(value));
    expect(output).not.toContain(JSON.stringify(value).slice(1, -1));
  }
  // Even partial plaintext fragments and control characters must not escape.
  expect(output).not.toMatch(/private-|cho_private|[\x00-\x1f\x7f]/);
}

describe("setup diagnostics use fixed allowlisted hints, never message remainders", () => {
  for (const [label, format] of formats) {
    it.each([...secrets, "private-nul\0secret"])(`${label}: %j`, (value) => {
      // A known safe hint remains useful even alongside adversarial encoded data.
      const output = redactedSetupError(new Error(`version mismatch: ${format(value)}`));
      expect(output).toBe(versionHint);
      assertNoPayload(output, [value], format);
      // Unknown details get explicit, actionable fallback rather than no context.
      expect(redactedSetupError(new Error(format(value)))).toBe(fallback);
      expect(redactedSetupError(new Error(output))).toBe(output);
    });
    it(`${label} retains ordinary hints inside nested error text`, () => {
      // JSON/URI/base64 can hide the entire message; never decode arbitrary data
      // just to echo it. Plain safe hints outside it remain available.
      const output = redactedSetupError(new Error(`no adapter registered: ${format(`version mismatch: ${secrets.join(" ")}`)}`));
      expect(output).toContain(adapterHint);
      assertNoPayload(output, secrets, format);
    });
  }
  it.each([
    ["version mismatch", versionHint],
    ["no adapter registered for private-provider", adapterHint],
    ["invalid plugin graph", "invalid plugin graph; rebuild the sdk profile and check plugin compatibility"],
    ["bad key cho_private_key", "authentication failed; check provider and Chorus credentials"],
    ["dsh plugin add: ERR_PNPM offline", "package registry unavailable; check network access and pnpm registry configuration"],
    ["did not complete JSON-RPC initialization", "did not complete JSON-RPC initialization; check the dsh sdk profile and runtime compatibility"],
    ["unexpected server identity private-server", "unexpected server identity; check that the sdk profile loads the expected dsh runtime"],
  ])("retains safe actionable classification for %s at both boundaries", (message, expected) => {
    expect(redactedSetupError(new Error(message))).toBe(expected);
    expect(redactedSetupError(new Error(expected))).toBe(expected);
  });
  it.each(["ENOENT", "EACCES", "ENOTDIR", "ENOSPC", "EROFS"])("retains filesystem/process classification %s", (code) => {
    const error = Object.assign(new Error(JSON.stringify(secrets)), { code, path: secrets[0] });
    const output = redactedSetupError(error);
    expect(output).toMatch(new RegExp(`^${code}: `));
    expect(redactedSetupError(new Error(output))).toBe(output);
    assertNoPayload(output, secrets, JSON.stringify);
  });
  it.each([null, undefined, {}, { message: secrets[0], code: "ENOENT private-code" }])("does not stringify arbitrary thrown objects: %j", (error) => {
    expect(redactedSetupError(error)).toBe(fallback);
  });
});

describe("actual DshSpawner setup error paths", () => {
  for (const [label, format] of formats) {
    it.each(["injected", "install", "validateProfile", "validateComposition", "reuse"])(`${label} at %s cannot escape either boundary`, async (stage) => {
      const root = mkdtempSync(join(tmpdir(), "chorus-dsh-safe-errors-"));
      const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const spawnImpl = vi.fn();
      const values = [...secrets, 'cho_private_credential"\\\n', 'private-provider"\\\n'];
      const message = `version mismatch; no adapter registered: ${values.map(format).join(" ")}`;
      const error = Object.assign(new Error(message), { code: format(values[0]), path: values[1] });
      const fail = () => { throw error; };
      let setupOutput;
      const prepare = vi.fn(async (options) => {
        if (stage === "injected") throw error;
        const opts = {
          ...options, root, runtimeVersion: "test",
          install() {}, validateProfile() {}, validateComposition() {},
        };
        if (stage === "reuse") await prepareManagedDshConfig(opts);
        try {
          return await prepareManagedDshConfig({ ...opts, [stage === "reuse" ? "validateProfile" : stage]: fail });
        } catch (failure) {
          setupOutput = failure.message;
          throw failure;
        }
      });
      const spawner = new DshSpawner({
        dshPath: "/fake/dsh", bundleVersion: "0.18.0", env: {}, platform: "linux",
        logger, spawnImpl, prepareManagedConfigFn: prepare,
        creds: { apiKey: values.at(-2), url: "https://chorus.test" },
        cliConfig: {
          args: secrets.map((value) => `--custom=${value}`),
          env: { ...Object.fromEntries(secrets.map((value, i) => [`ORDINARY_${i}`, value])), DSH_PROVIDER: values.at(-1) },
        },
      });
      try {
        const result = await spawner.wake({ sessionId: "test", cwd: "/work", prompt: "wake" });
        expect(result.exitCode).toBeNull();
        expect(prepare).toHaveBeenCalledOnce();
        expect(spawnImpl).not.toHaveBeenCalled();
        expect(logger.error).toHaveBeenCalledOnce();
        const output = logger.error.mock.calls[0][0];
        expect(output).toContain("cannot prepare managed dsh profile:");
        expect(output).toContain(versionHint);
        expect(output).toContain(adapterHint);
        assertNoPayload(output, values, format);
        if (stage !== "injected") {
          assertNoPayload(setupOutput, values, format);
          // The second boundary retains all fixed hints, without extra erosion.
          expect(output).toBe(`[Chorus] cannot prepare managed dsh profile: ${setupOutput}`);
        }
        if (stage === "install") expect(output).toContain("profile installation failed");
        if (stage === "validateComposition") {
          expect(output).toContain("composition validation failed");
          expect(output).toContain("non-default provider");
          expect(output).toContain("CHORUS_DSH_HOME");
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
  it.each(["install", "validateComposition"])("preserves structured errno before wrapping a %s failure", async (stage) => {
    const root = mkdtempSync(join(tmpdir(), "chorus-dsh-errno-"));
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const spawnImpl = vi.fn();
    const spawner = new DshSpawner({
      dshPath: "/fake/dsh", env: {}, logger, spawnImpl,
      prepareManagedConfigFn: (options) => prepareManagedDshConfig({
        ...options, root, bundleVersion: "0.18.0", runtimeVersion: "test",
        install() {}, validateProfile() {}, validateComposition() {},
        [stage]: () => { throw Object.assign(new Error(JSON.stringify(secrets)), { code: "EACCES" }); },
      }),
    });
    try {
      await spawner.wake({ sessionId: "test", prompt: "wake" });
      expect(spawnImpl).not.toHaveBeenCalled();
      const output = logger.error.mock.calls[0][0];
      expect(output).toContain("EACCES: permission denied; check executable and directory permissions");
      expect(output).toContain(stage === "install" ? "profile installation failed" : "composition validation failed");
      assertNoPayload(output, secrets, JSON.stringify);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("gives an actionable fallback for wholly unrecognized encoded errors", async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const spawnImpl = vi.fn();
    const spawner = new DshSpawner({
      dshPath: "/fake/dsh", env: {}, logger, spawnImpl,
      prepareManagedConfigFn: async () => { throw new Error(Buffer.from(JSON.stringify(secrets)).toString("base64")); },
    });
    await spawner.wake({ sessionId: "test", prompt: "wake" });
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(`[Chorus] cannot prepare managed dsh profile: ${fallback}`);
  });
});
