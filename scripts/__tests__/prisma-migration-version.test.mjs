import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = resolve(dirname(fileURLToPath(import.meta.url)), "../prisma-migration-version.mjs");
const names = ["prisma", "@prisma/client", "@prisma/adapter-pg"];

function fixture(t, { declared = {}, installed = {}, missing } = {}) {
  const root = mkdtempSync(join(tmpdir(), "chorus-prisma-version-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "package.json"), JSON.stringify({
    dependencies: Object.fromEntries(names.map((name) => [name, declared[name] ?? "7.10.0"])),
  }));
  for (const name of names) {
    if (missing === name) continue;
    const directory = join(root, "node_modules", name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "package.json"), JSON.stringify({
      name,
      version: installed[name] ?? declared[name] ?? "7.10.0",
      exports: { ".": "./index.js" },
    }));
    writeFileSync(join(directory, "index.js"), 'throw new Error("Package entry must not be executed");\n');
  }
  return () => spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
}

test("exports the matching installed version without private manifest imports or package execution", (t) => {
  const result = fixture(t)();
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "7.10.0\n");
  assert.equal(result.stderr, "");
});

test("accepts a later stable 7.x pin when every installed package matches", (t) => {
  const result = fixture(t, {
    declared: Object.fromEntries(names.map((name) => [name, "7.11.2"])),
  })();
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "7.11.2\n");
});

test("fails when declared and installed package versions differ", (t) => {
  const result = fixture(t, { installed: { prisma: "7.3.0" } })();
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /installed 7\.3\.0 does not match pin 7\.10\.0/);
});

test("fails even when each package individually matches a different pin", (t) => {
  const result = fixture(t, { declared: { "@prisma/adapter-pg": "7.9.0" } })();
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /versions must match/);
});

for (const version of ["7.10.0-rc.1", "^7.10.0", "latest", "8.0.0", "7.010.0", "7.10.0;echo injected"]) {
  test(`rejects an unsafe or non-stable pin: ${version}`, (t) => {
    const result = fixture(t, { declared: { prisma: version } })();
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /exact stable Prisma 7\.x pin/);
  });
}

test("fails when an installed dependency is missing", (t) => {
  const result = fixture(t, { missing: "@prisma/client" })();
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Cannot select production migration CLI/);
});
