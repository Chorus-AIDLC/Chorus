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
  DSH_PEERS,
  prepareManagedDshConfig,
  renderManagedDshConfig,
  validateManagedDshImports,
} from "../dsh-managed-config.mjs";

function tempRoot() {
  return mkdtempSync(join(tmpdir(), "chorus-dsh-managed-"));
}

function fakePackage(project, name) {
  const dir = join(project, "node_modules", ...name.split("/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({
    name,
    type: "module",
    main: "index.mjs",
  }));
  writeFileSync(join(dir, "index.mjs"), `export const name = ${JSON.stringify(name)};\n`);
  if (name === DSH_BUNDLE) {
    mkdirSync(join(dir, "dist"), { recursive: true });
    mkdirSync(join(dir, "skills"), { recursive: true });
    writeFileSync(join(dir, "dist", "persona.mjs"), "export default {};\n");
  }
}

describe("managed dsh composition", () => {
  it("renders a secret-free complete config with the bundle and all four peers", () => {
    const text = renderManagedDshConfig();
    expect(text).toContain(`name: '${DSH_BUNDLE}'`);
    for (const peer of DSH_PEERS) expect(text).toContain(peer);
    expect(text).toContain("id: sdk-jsonrpc-server");
    expect(text).toContain("id: skill");
    expect(text).toContain("id: tool-skill");
    expect(text).toContain("chorusDshConfig.url");
    expect(text).toContain("chorusDshConfig.apiKey");
    expect(text).not.toContain("cho_secret");
  });

  it("hard-resolves and loads all five imports from the config anchor", async () => {
    const root = tempRoot();
    try {
      writeFileSync(join(root, "cordis.yml"), "[]\n");
      for (const name of [DSH_BUNDLE, ...DSH_PEERS]) fakePackage(root, name);
      const result = await validateManagedDshImports(root);
      expect(Object.keys(result.resolved)).toEqual([DSH_BUNDLE, ...DSH_PEERS]);
      expect(result.usedBundleFallback).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses an absolute bundle fallback while peers remain name-resolved", async () => {
    const root = tempRoot();
    try {
      writeFileSync(join(root, "cordis.yml"), "[]\n");
      for (const peer of DSH_PEERS) fakePackage(root, peer);
      const fallback = join(root, "external", "dist", "chorus-dsh.mjs");
      mkdirSync(dirname(fallback), { recursive: true });
      writeFileSync(fallback, "export const name = 'chorus-dsh';\n");
      const resolvedNames = [];
      const result = await validateManagedDshImports(root, {
        resolveImport(name) {
          resolvedNames.push(name);
          if (name === DSH_BUNDLE) throw new Error("not linked by name");
          return join(root, "node_modules", ...name.split("/"), "index.mjs");
        },
        resolveBundleEntry: () => fallback,
      });
      expect(result.usedBundleFallback).toBe(true);
      expect(result.bundleEntry).toBe(fallback);
      expect(resolvedNames).toEqual(expect.arrayContaining(DSH_PEERS));
      const config = renderManagedDshConfig(fallback);
      expect(config).toContain(`name: '${fallback}'`);
      expect(config).toContain(`name: '${join(dirname(fallback), "persona.mjs")}'`);
      for (const peer of DSH_PEERS) expect(config).toContain(peer);
      expect(config).not.toContain("createRequire(baseUrl).resolve('@chorus-aidlc/chorus-dsh/package.json')");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("installs the required direct packages once and reuses validated active state", async () => {
    const root = tempRoot();
    const install = vi.fn();
    const validateImports = vi.fn(async () => ({
      resolved: Object.fromEntries([DSH_BUNDLE, ...DSH_PEERS].map((name) => [name, `/x/${name}`])),
      bundleEntry: "/x/bundle.mjs",
      usedBundleFallback: false,
    }));
    const validateComposition = vi.fn();
    try {
      const first = await prepareManagedDshConfig({
        root,
        bundleVersion: "0.16.3",
        install,
        validateImports,
        validateComposition,
        runtimeExists: () => true,
        statePathExists: () => true,
      });
      expect(first.reused).toBe(false);
      const pkg = JSON.parse(readFileSync(join(dirname(first.configPath), "package.json"), "utf8"));
      expect(pkg.dependencies[DSH_BUNDLE]).toBe("0.16.3");
      for (const peer of DSH_PEERS) expect(pkg.dependencies[peer]).toBe("0.1.0-rc.7");
      expect(readFileSync(join(dirname(first.configPath), ".npmrc"), "utf8")).toBe("node-linker=hoisted\n");

      const second = await prepareManagedDshConfig({
        root,
        bundleVersion: "0.16.3",
        install,
        validateImports,
        validateComposition,
        runtimeExists: () => true,
        statePathExists: () => true,
      });
      expect(second).toMatchObject({ reused: true, configPath: first.configPath });
      expect(install).toHaveBeenCalledTimes(1);
      expect(validateComposition).toHaveBeenCalledTimes(1);
      expect(validateImports).toHaveBeenCalledTimes(2);
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
        creds: { url: "https://chorus.test", apiKey: "cho_do_not_log" },
        install: vi.fn(),
        validateImports: async () => ({
          resolved: {},
          bundleEntry: "/x/bundle.mjs",
          usedBundleFallback: false,
        }),
        runtimeExists: () => true,
        validateComposition: () => { throw new Error("bad key cho_do_not_log"); },
      })).rejects.toThrow(/bad key \[REDACTED\]/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves the last-known-good marker when update validation fails", async () => {
    const root = tempRoot();
    const validImports = async () => ({
      resolved: {},
      bundleEntry: "/x/bundle.mjs",
      usedBundleFallback: false,
    });
    try {
      const good = await prepareManagedDshConfig({
        root,
        bundleVersion: "0.16.3",
        install: vi.fn(),
        validateImports: validImports,
        validateComposition: vi.fn(),
        runtimeExists: () => true,
      });
      await expect(prepareManagedDshConfig({
        root,
        bundleVersion: "0.16.4",
        install: vi.fn(),
        validateImports: validImports,
        validateComposition: () => { throw new Error("invalid plugin graph"); },
        runtimeExists: () => true,
      })).rejects.toThrow(/composition validation failed.*invalid plugin graph/);
      const marker = JSON.parse(readFileSync(join(root, "active.json"), "utf8"));
      expect(marker.configPath).toBe(good.configPath);
      expect(existsSync(good.configPath)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports peer resolution failures with the package name", async () => {
    const root = tempRoot();
    try {
      writeFileSync(join(root, "cordis.yml"), "[]\n");
      const fallback = join(root, "bundle.mjs");
      writeFileSync(fallback, "export {};\n");
      await expect(validateManagedDshImports(root, {
        resolveImport(name) {
          if (name === DSH_BUNDLE) throw new Error("bundle missing");
          throw new Error("peer missing");
        },
        resolveBundleEntry: () => fallback,
      })).rejects.toThrow(new RegExp(DSH_PEERS[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports package-manager failures and leaves no active state", async () => {
    const root = tempRoot();
    try {
      await expect(prepareManagedDshConfig({
        root,
        bundleVersion: "0.16.3",
        install: () => { throw new Error("spawn pnpm ENOENT"); },
      })).rejects.toThrow(/package installation failed.*pnpm ENOENT/);
      expect(existsSync(join(root, "active.json"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
