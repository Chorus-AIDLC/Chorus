import { describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  DSH_BUNDLE,
  DSH_PROFILE,
  DSH_RC_VERSION,
  DEFAULT_DSH_PROVIDER,
  RUNTIME_IDENTITY,
  buildProviderPatch,
  prepareManagedDshConfig,
  validateManagedDshComposition,
  validateManagedDshProfile,
} from "../dsh-managed-config.mjs";

function tempRoot() {
  return mkdtempSync(join(tmpdir(), "chorus-dsh-managed-"));
}

/** A runCommand double that answers the validation `initialize` with the SDK
 * runtime identity and ignores the plugin-add call (records both). */
function fakeRunner(record) {
  return vi.fn((command, argv) => {
    record.push({ command, argv });
    return {
      stdout: `${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { serverInfo: { name: RUNTIME_IDENTITY } } })}\n`,
      status: 0,
    };
  });
}

describe("managed dsh profile composition", () => {
  it("emits no provider overlay for the default provider and a targeted one otherwise", () => {
    expect(buildProviderPatch(DEFAULT_DSH_PROVIDER)).toBe(null);
    expect(buildProviderPatch("")).toBe(null);
    expect(buildProviderPatch(undefined)).toBe(null);
    const patch = buildProviderPatch("acme-cloud");
    expect(patch.fileName).toBe("chorus-provider.patch.yml");
    expect(patch.yaml).toContain("id: agent-default-model");
    expect(patch.yaml).toContain('provider: "acme-cloud"');
    expect(patch.yaml).toContain("CHORUS_DSH_PROVIDER=acme-cloud");
  });

  it("validates a real profile home by its manifest bundle list and installed package", () => {
    const home = tempRoot();
    try {
      const profileDir = join(home, "profiles", DSH_PROFILE);
      mkdirSync(profileDir, { recursive: true });
      writeFileSync(
        join(profileDir, "package.json"),
        JSON.stringify({
          name: "dsh-profile-sdk",
          dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-sdk-app", DSH_BUNDLE] } },
        }),
      );
      // Missing installed package → fails.
      expect(() => validateManagedDshProfile(home)).toThrow(/did not install/);
      const pkgDir = join(profileDir, "node_modules", ...DSH_BUNDLE.split("/"));
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: DSH_BUNDLE }));
      const result = validateManagedDshProfile(home);
      expect(result.bundles).toContain(DSH_BUNDLE);
      expect(result.profileDir).toBe(profileDir);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("rejects a profile whose manifest omits the Chorus bundle", () => {
    expect(() =>
      validateManagedDshProfile("/x", {
        readJson: () => ({ dsh: { profile: { bundles: ["@deepseek-ai/dsh-base"] } } }),
        profileExists: () => true,
      }),
    ).toThrow(/missing the @chorus-aidlc\/chorus-dsh bundle/);
  });

  it("drives `dsh --profile sdk` initialize over stdin and asserts the runtime identity", () => {
    const calls = [];
    const runner = fakeRunner(calls);
    validateManagedDshComposition("/managed/home", {
      dshPath: "/opt/dsh",
      runCommand: runner,
      creds: { url: "https://c.example", apiKey: "cho_secret" },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("/opt/dsh");
    expect(calls[0].argv).toEqual(["--profile", "sdk"]);
    const opts = runner.mock.calls[0][2];
    expect(opts.env.DSH_HOME).toBe("/managed/home");
    expect(opts.env.CHORUS_API_KEY).toBe("cho_secret");
    const request = JSON.parse(opts.input);
    expect(request).toMatchObject({ id: 1, method: "initialize" });
    expect(request.params.provider).toBe(DEFAULT_DSH_PROVIDER);

    // A non-identity / no-id response fails visibly.
    expect(() =>
      validateManagedDshComposition("/managed/home", {
        dshPath: "/opt/dsh",
        runCommand: () => ({ stdout: '{"jsonrpc":"2.0","id":2,"result":{}}', status: 0 }),
      }),
    ).toThrow(/did not complete JSON-RPC initialization/);
    expect(() =>
      validateManagedDshComposition("/managed/home", {
        dshPath: "/opt/dsh",
        runCommand: () => ({ stdout: '{"jsonrpc":"2.0","id":1,"result":{"serverInfo":{"name":"other"}}}', status: 0 }),
      }),
    ).toThrow(/unexpected server identity/);
  });

  it("appends --patch to the validation launch when a provider overlay is present", () => {
    const calls = [];
    validateManagedDshComposition("/managed/home", {
      dshPath: "/opt/dsh",
      patchPath: "/managed/home/chorus-provider.patch.yml",
      runCommand: fakeRunner(calls),
    });
    expect(calls[0].argv).toEqual([
      "--profile",
      "sdk",
      "--patch",
      "/managed/home/chorus-provider.patch.yml",
    ]);
  });

  it("composes the profile via `dsh plugin add -w`, validates it, and reuses the active marker", async () => {
    const root = tempRoot();
    const calls = [];
    const validateProfile = vi.fn();
    try {
      const first = await prepareManagedDshConfig({
        root,
        bundleVersion: "0.16.3",
        dshPath: "/opt/dsh",
        runCommand: fakeRunner(calls),
        validateProfile,
        statePathExists: () => true,
      });
      expect(first.reused).toBe(false);
      expect(first.patchPath).toBe(null);
      expect(existsSync(first.home)).toBe(true);

      // First runCommand = the plugin add; second = the composition validation.
      expect(calls[0].command).toBe("/opt/dsh");
      expect(calls[0].argv).toEqual(["plugin", "--profile", "sdk", "add", `${DSH_BUNDLE}@0.16.3`, "-w"]);
      expect(calls[1].argv).toEqual(["--profile", "sdk"]);

      const marker = JSON.parse(readFileSync(join(root, "active.json"), "utf8"));
      expect(marker.home).toBe(first.home);
      expect(marker.patchPath).toBe(null);
      expect(marker.version).toBe(2);

      const second = await prepareManagedDshConfig({
        root,
        bundleVersion: "0.16.3",
        dshPath: "/opt/dsh",
        runCommand: fakeRunner([]),
        validateProfile,
        statePathExists: () => true,
      });
      expect(second).toMatchObject({ reused: true, home: first.home });
      // Reuse re-validates the profile cheaply but never re-installs or re-composes.
      expect(validateProfile).toHaveBeenCalledTimes(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("overrides the plugin-add spec from CHORUS_DSH_BUNDLE_SPEC (local build) and lets opts.bundleSpec win", async () => {
    const root = tempRoot();
    try {
      // env override → the daemon installs a local build (tarball/dir) instead of `@<published version>`.
      const envCalls = [];
      await prepareManagedDshConfig({
        root,
        bundleVersion: "0.17.2",
        dshPath: "/opt/dsh",
        env: { CHORUS_DSH_BUNDLE_SPEC: "/build/chorus-dsh.tgz" },
        runCommand: fakeRunner(envCalls),
        validateProfile: vi.fn(),
        statePathExists: () => true,
      });
      expect(envCalls[0].argv).toEqual(["plugin", "--profile", "sdk", "add", "/build/chorus-dsh.tgz", "-w"]);

      // explicit opts.bundleSpec still wins over the env override.
      const optCalls = [];
      await prepareManagedDshConfig({
        root,
        bundleVersion: "0.17.2",
        bundleSpec: `${DSH_BUNDLE}@9.9.9`,
        dshPath: "/opt/dsh",
        env: { CHORUS_DSH_BUNDLE_SPEC: "/build/chorus-dsh.tgz" },
        runCommand: fakeRunner(optCalls),
        validateProfile: vi.fn(),
        statePathExists: () => true,
      });
      expect(optCalls[0].argv).toEqual(["plugin", "--profile", "sdk", "add", `${DSH_BUNDLE}@9.9.9`, "-w"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("writes a provider --patch overlay and records it in the marker for a non-default provider", async () => {
    const root = tempRoot();
    const calls = [];
    try {
      const prepared = await prepareManagedDshConfig({
        root,
        bundleVersion: "0.16.3",
        dshPath: "/opt/dsh",
        env: { ...process.env, CHORUS_DSH_PROVIDER: "acme-cloud" },
        runCommand: fakeRunner(calls),
        validateProfile: vi.fn(),
        statePathExists: () => true,
      });
      expect(prepared.patchPath).toBe(join(prepared.home, "chorus-provider.patch.yml"));
      expect(readFileSync(prepared.patchPath, "utf8")).toContain('provider: "acme-cloud"');
      // The validation launch carried the overlay.
      const validationCall = calls.find((c) => c.argv.includes("--patch"));
      expect(validationCall.argv).toEqual(["--profile", "sdk", "--patch", prepared.patchPath]);
      const marker = JSON.parse(readFileSync(join(root, "active.json"), "utf8"));
      expect(marker.patchPath).toBe(prepared.patchPath);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("redacts credentials from composition diagnostics", async () => {
    const root = tempRoot();
    try {
      await expect(prepareManagedDshConfig({
        root,
        bundleVersion: "0.16.3",
        dshPath: "/opt/dsh",
        creds: { url: "https://chorus.test", apiKey: "cho_do_not_log" },
        install: vi.fn(),
        validateProfile: vi.fn(),
        validateComposition: () => { throw new Error("bad key cho_do_not_log"); },
      })).rejects.toThrow(/bad key \[REDACTED\]/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves the last-known-good marker when an update's validation fails", async () => {
    const root = tempRoot();
    try {
      const good = await prepareManagedDshConfig({
        root,
        bundleVersion: "0.16.3",
        dshPath: "/opt/dsh",
        install: vi.fn(),
        validateProfile: vi.fn(),
        validateComposition: vi.fn(),
      });
      await expect(prepareManagedDshConfig({
        root,
        bundleVersion: "0.16.4",
        dshPath: "/opt/dsh",
        install: vi.fn(),
        validateProfile: vi.fn(),
        validateComposition: () => { throw new Error("invalid plugin graph"); },
      })).rejects.toThrow(/composition validation failed.*invalid plugin graph/);
      const marker = JSON.parse(readFileSync(join(root, "active.json"), "utf8"));
      expect(marker.home).toBe(good.home);
      expect(existsSync(good.home)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports plugin-add failures and leaves no active state", async () => {
    const root = tempRoot();
    try {
      await expect(prepareManagedDshConfig({
        root,
        bundleVersion: "0.16.3",
        dshPath: "/opt/dsh",
        install: () => { throw new Error("dsh plugin add: ERR_PNPM offline"); },
      })).rejects.toThrow(/profile installation failed.*ERR_PNPM offline/);
      expect(existsSync(join(root, "active.json"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires a bundle version and the dsh CLI path", async () => {
    await expect(prepareManagedDshConfig({ root: "/x" })).rejects.toThrow(/bundle version/);
    await expect(prepareManagedDshConfig({ root: "/x", bundleVersion: "0.16.3" })).rejects.toThrow(/dsh CLI/);
    expect(DSH_RC_VERSION).toBe("0.1.2-rc.1");
  });
});
