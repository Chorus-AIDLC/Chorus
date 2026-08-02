import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, symlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DirectoryDiscoveryError,
  discoverDirectories,
  isPathWithin,
  validateDirectory,
} from "../directory-discovery.mjs";

const cleanup = [];
afterEach(async () => Promise.all(cleanup.splice(0).map((p) => rm(p, { recursive: true, force: true }))));

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "chorus-discovery-"));
  cleanup.push(root);
  await Promise.all([
    mkdir(path.join(root, "project-a")),
    mkdir(path.join(root, "Project-b")),
    mkdir(path.join(root, "other")),
    mkdir(path.join(root, ".hidden")),
    writeFile(path.join(root, "project-file"), "x"),
  ]);
  await symlink(path.join(root, "project-a"), path.join(root, "project-link"));
  return root;
}

describe("directory discovery", () => {
  it("returns matching direct directories only, without metadata", async () => {
    const root = await fixture();
    const result = await discoverDirectories({ prefix: path.join(root, "pro"), browseRoots: [root] });
    expect(result.items.map((x) => x.name)).toEqual(["project-a"]);
    expect(result.items.every((x) => Object.keys(x).sort().join(",") === "name,path")).toBe(true);
    expect(result.items.some((x) => x.name === "project-link")).toBe(false);
  });

  it("distinguishes an empty success from an error", async () => {
    const root = await fixture();
    expect((await discoverDirectories({ prefix: path.join(root, "zzz"), browseRoots: [root] })).items)
      .toEqual([]);
    await expect(discoverDirectories({ prefix: path.join(root, "..", "secret"), browseRoots: [root] }))
      .rejects.toMatchObject({ code: "OUTSIDE_ROOT" });
  });

  it("provides stable pagination and rejects excessive limits", async () => {
    const root = await fixture();
    const first = await discoverDirectories({ prefix: `${root}${path.sep}`, browseRoots: [root], limit: 2 });
    const second = await discoverDirectories({
      prefix: `${root}${path.sep}`, browseRoots: [root], limit: 2, cursor: first.nextCursor,
    });
    expect(first.items.map((x) => x.name)).toEqual(["other", "project-a"]);
    expect(second.items.map((x) => x.name)).toEqual(["Project-b"]);
    await expect(discoverDirectories({ prefix: root, browseRoots: [root], limit: 101 }))
      .rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
  });

  it("validates an existing directory under a root", async () => {
    const root = await fixture();
    await expect(validateDirectory({ cwd: path.join(root, "project-a"), browseRoots: [root] }))
      .resolves.toMatchObject({ valid: true, normalizedPath: path.join(root, "project-a") });
  });

  it("rejects discovery and validation through an intermediate symlink", async () => {
    const root = await fixture();
    const outside = await mkdtemp(path.join(tmpdir(), "chorus-outside-"));
    cleanup.push(outside);
    await mkdir(path.join(outside, "escaped"));
    await symlink(outside, path.join(root, "intermediate-link"));

    await expect(discoverDirectories({
      prefix: path.join(root, "intermediate-link", "esc"),
      browseRoots: [root],
    })).rejects.toMatchObject({ code: "OUTSIDE_ROOT" });
    await expect(validateDirectory({
      cwd: path.join(root, "intermediate-link", "escaped"),
      browseRoots: [root],
    })).rejects.toMatchObject({ code: "OUTSIDE_ROOT" });
  });

  it("uses component-aware POSIX and Windows containment", () => {
    expect(isPathWithin("/home/u", "/home/u/repo", path.posix)).toBe(true);
    expect(isPathWithin("/home/u", "/home/user2", path.posix)).toBe(false);
    expect(isPathWithin("C:\\Users\\u", "C:\\Users\\u\\repo", path.win32)).toBe(true);
    expect(isPathWithin("C:\\Users\\u", "C:\\Users\\user2", path.win32)).toBe(false);
  });

  it("maps a hard timeout to TIMEOUT", async () => {
    const fsApi = {
      realpath: async (value) => value,
      lstat: () => new Promise(() => {}),
      access: async () => {},
      readdir: async () => [],
    };
    await expect(discoverDirectories({
      prefix: "/root/a", browseRoots: ["/root"], fsApi, timeoutMs: 5,
    })).rejects.toEqual(expect.objectContaining({ code: "TIMEOUT" }));
  });
});
