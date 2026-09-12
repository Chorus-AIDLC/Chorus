/**
 * Tests for docker/ensure-secret.sh — the POSIX-sh library sourced by
 * docker-entrypoint.sh that bootstraps NEXTAUTH_SECRET (GitHub issue #559).
 *
 * The library is driven through a real `sh` process (child_process) with
 * CHORUS_DATA_DIR pointing at a fresh tmp dir. Skipped when `sh` or `openssl`
 * are unavailable (e.g. Windows dev boxes).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../../..");
const LIB = path.join(REPO_ROOT, "docker", "ensure-secret.sh");
const ENTRYPOINT = path.join(REPO_ROOT, "docker-entrypoint.sh");

const PLACEHOLDERS = [
  "chorus-docker-secret-change-in-production",
  "chorus-local-secret",
  "your-secret-key-change-in-production",
  "change-me-to-a-random-secret",
] as const;

const SENTINEL = "__CHORUS_EXPORTED__=";

function hasBin(bin: string): boolean {
  try {
    return spawnSync(bin, ["--version"], { stdio: "ignore" }).error === undefined;
  } catch {
    return false;
  }
}

const shAvailable = hasBin("sh") && fs.existsSync(LIB);
const opensslAvailable = shAvailable && spawnSync("sh", ["-c", "command -v openssl"], { stdio: "ignore" }).status === 0;
const canRun = shAvailable && opensslAvailable;
// BusyBox ash is the shell inside the production image; exercise the new
// failure / race paths under it too when a `busybox` binary is on PATH.
const busybox =
  canRun && spawnSync("sh", ["-c", "command -v busybox"], { stdio: "ignore" }).status === 0
    ? spawnSync("busybox", ["sh", "-c", "true"], { stdio: "ignore" }).status === 0
    : false;

type Shell = { name: string; argv: string[] };
const HOST_SH: Shell = { name: "sh", argv: ["sh"] };
const BUSYBOX_SH: Shell = { name: "busybox sh", argv: ["busybox", "sh"] };

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  /** Value of NEXTAUTH_SECRET as seen by the parent shell after the call (or "" if unset). */
  exported: string;
  /** stdout with the sentinel line removed. */
  log: string;
}

/**
 * Source the library, call ensure_nextauth_secret, then print the exported
 * value on a sentinel line (only used by tests — the library itself never
 * prints the secret). `extraAfter` runs after the call and before the sentinel.
 * `prelude` runs BEFORE the library is sourced (same shell, so stub functions
 * such as `openssl(){ ...; }` are visible inside the library's subshells).
 */
function runEnsure(
  dataDir: string,
  env: Record<string, string | undefined> = {},
  opts: { extraAfter?: string; pathPrefix?: string; prelude?: string; shell?: Shell } = {}
): RunResult {
  const shell = opts.shell ?? HOST_SH;
  const script = [
    opts.prelude ?? "",
    `. "${LIB}"`,
    // Use a subshell so a non-zero return from the function does not abort
    // before we print the sentinel; `${NEXTAUTH_SECRET-}` shows the env-visible value.
    `if ensure_nextauth_secret; then rc=0; else rc=$?; fi`,
    opts.extraAfter ?? "",
    `printf '%s%s\\n' '${SENTINEL}' "$(sh -c 'printf %s "\${NEXTAUTH_SECRET-}"')"`,
    `exit $rc`,
  ].join("\n");

  const childEnv: NodeJS.ProcessEnv = {
    NODE_ENV: process.env.NODE_ENV,
    PATH: opts.pathPrefix ? `${opts.pathPrefix}:${process.env.PATH}` : process.env.PATH,
    HOME: process.env.HOME,
    CHORUS_DATA_DIR: dataDir,
  };
  // NEXTAUTH_SECRET must be genuinely unset unless the caller provides it.
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) childEnv[k] = v;
  }

  const res = spawnSync(shell.argv[0], [...shell.argv.slice(1), "-c", script], { env: childEnv, encoding: "utf8" });
  const lines = res.stdout.split("\n");
  const sentinelLine = lines.find((l) => l.startsWith(SENTINEL)) ?? SENTINEL;
  const exported = sentinelLine.slice(SENTINEL.length);
  const log = lines.filter((l) => !l.startsWith(SENTINEL)).join("\n");
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, exported, log };
}

const HEX64 = /^[0-9a-f]{64}$/;
const PERSIST_HINT = "persistent volume, otherwise the secret rotates";
const REPLICA_HINT = "set the same NEXTAUTH_SECRET explicitly on every replica";

describe.skipIf(!canRun)("docker/ensure-secret.sh", () => {
  let dataDir: string;
  let secretFile: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chorus-ensure-secret-"));
    secretFile = path.join(dataDir, ".secret");
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("passes `sh -n` for both the library and the entrypoint", () => {
    const res = spawnSync("sh", ["-n", ENTRYPOINT, LIB], { encoding: "utf8" });
    expect(res.status, res.stderr).toBe(0);
  });

  it("defines the exact known-insecure list and the two functions", () => {
    const src = fs.readFileSync(LIB, "utf8");
    const m = src.match(/CHORUS_KNOWN_INSECURE_SECRETS="([^"]*)"/);
    expect(m).not.toBeNull();
    expect(m![1].split("\n")).toEqual([...PLACEHOLDERS]);
    expect(src).toMatch(/^is_known_insecure_secret\(\)/m);
    expect(src).toMatch(/^ensure_nextauth_secret\(\)/m);
    expect(src).toContain('CHORUS_DATA_DIR="${CHORUS_DATA_DIR:-/app/data}"');
  });

  it("is_known_insecure_secret matches exactly the placeholders", () => {
    const script = (v: string) => `. "${LIB}"; is_known_insecure_secret "${v}"`;
    for (const p of PLACEHOLDERS) {
      expect(spawnSync("sh", ["-c", script(p)]).status).toBe(0);
    }
    expect(spawnSync("sh", ["-c", script("chorus-local-secret-x")]).status).not.toBe(0);
    expect(spawnSync("sh", ["-c", script("")]).status).not.toBe(0);
    expect(spawnSync("sh", ["-c", script("abcdef")]).status).not.toBe(0);
  });

  it("unset env → generates, persists with mode 0600, exports 64 hex chars", () => {
    const r = runEnsure(dataDir);
    expect(r.status, r.stderr).toBe(0);
    expect(r.exported).toMatch(HEX64);
    expect(fs.existsSync(secretFile)).toBe(true);
    expect(fs.readFileSync(secretFile, "utf8").trim()).toBe(r.exported);
    const mode = fs.statSync(secretFile).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(r.log).toContain("NEXTAUTH_SECRET not set");
    expect(r.log).toContain("generated a new random secret");
    expect(r.log).toContain(PERSIST_HINT);
    expect(r.log).toContain(REPLICA_HINT);
    expect(r.log).not.toContain(r.exported);
    expect(r.stderr).not.toContain(r.exported);
  });

  it("empty env string → treated as missing and generated", () => {
    const r = runEnsure(dataDir, { NEXTAUTH_SECRET: "" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.exported).toMatch(HEX64);
    expect(r.log).toContain("NEXTAUTH_SECRET not set");
  });

  for (const placeholder of PLACEHOLDERS) {
    it(`placeholder "${placeholder}" → replaced with a generated secret`, () => {
      const r = runEnsure(dataDir, { NEXTAUTH_SECRET: placeholder });
      expect(r.status, r.stderr).toBe(0);
      expect(r.exported).toMatch(HEX64);
      expect(r.exported).not.toBe(placeholder);
      expect(PLACEHOLDERS as readonly string[]).not.toContain(r.exported);
      expect(fs.readFileSync(secretFile, "utf8").trim()).toBe(r.exported);
      expect(r.log).toContain("WARNING: NEXTAUTH_SECRET was set to a publicly known placeholder");
      expect(r.log).toContain("#559");
      expect(r.log).toContain(PERSIST_HINT);
      expect(r.log).toContain(REPLICA_HINT);
      expect(r.log).not.toContain(r.exported);
    });
  }

  it("explicit non-placeholder env → untouched, no file, no log output", () => {
    const safe = "my-very-secure-explicit-secret";
    const r = runEnsure(dataDir, { NEXTAUTH_SECRET: safe });
    expect(r.status, r.stderr).toBe(0);
    expect(r.exported).toBe(safe);
    expect(fs.existsSync(secretFile)).toBe(false);
    expect(r.log.trim()).toBe("");
    expect(r.stderr).toBe("");
  });

  it("explicit non-placeholder env → data dir is not even created", () => {
    const nested = path.join(dataDir, "does-not-exist");
    const r = runEnsure(nested, { NEXTAUTH_SECRET: "explicit-secure" });
    expect(r.status).toBe(0);
    expect(fs.existsSync(nested)).toBe(false);
  });

  it("existing non-empty .secret → reused byte-identically, not regenerated", () => {
    const persisted = "a".repeat(40) + "persisted-value";
    fs.writeFileSync(secretFile, persisted + "\n");
    const r = runEnsure(dataDir);
    expect(r.status, r.stderr).toBe(0);
    expect(r.exported).toBe(persisted);
    expect(fs.readFileSync(secretFile, "utf8")).toBe(persisted + "\n"); // untouched
    expect(r.log).toContain("reusing the persisted secret");
    expect(r.log).not.toContain("generated");
    expect(r.log).not.toContain(persisted);
    expect(r.log).toContain(PERSIST_HINT);
    expect(r.log).toContain(REPLICA_HINT);
  });

  it("second run reuses the secret generated on the first run", () => {
    const first = runEnsure(dataDir);
    expect(first.status).toBe(0);
    const second = runEnsure(dataDir);
    expect(second.status).toBe(0);
    expect(second.exported).toBe(first.exported);
    expect(second.log).toContain("reusing the persisted secret");
  });

  it("existing .secret is reused even when env holds a placeholder", () => {
    fs.writeFileSync(secretFile, "persisted-good-secret\n");
    const r = runEnsure(dataDir, { NEXTAUTH_SECRET: PLACEHOLDERS[0] });
    expect(r.status).toBe(0);
    expect(r.exported).toBe("persisted-good-secret");
    expect(r.log).toContain("WARNING");
    expect(r.log).toContain("reusing the persisted secret");
  });

  it("empty .secret → regenerated (stale empty file is removed before install)", () => {
    fs.writeFileSync(secretFile, "");
    const r = runEnsure(dataDir);
    expect(r.status, r.stderr).toBe(0);
    expect(r.exported).toMatch(HEX64);
    expect(fs.readFileSync(secretFile, "utf8").trim()).toBe(r.exported);
    expect(fs.statSync(secretFile).mode & 0o777).toBe(0o600);
    expect(r.log).toContain("generated a new random secret");
  });

  it("whitespace-only .secret → regenerated", () => {
    fs.writeFileSync(secretFile, " \n\t \n");
    const r = runEnsure(dataDir);
    expect(r.status, r.stderr).toBe(0);
    expect(r.exported).toMatch(HEX64);
    expect(r.log).toContain("generated a new random secret");
  });

  it("directory at .secret → non-zero, stderr message, nothing exported", () => {
    fs.mkdirSync(secretFile);
    const r = runEnsure(dataDir);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("not a regular file");
    expect(r.exported).toBe("");
    expect(r.log).not.toContain(PERSIST_HINT);
  });

  it("persisted placeholder in .secret → non-zero, nothing exported", () => {
    fs.writeFileSync(secretFile, PLACEHOLDERS[1] + "\n");
    const r = runEnsure(dataDir);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("publicly known placeholder");
    expect(r.exported).toBe("");
  });

  it("simulated read failure (stub `cat` on PATH) → non-zero, nothing exported", () => {
    fs.writeFileSync(secretFile, "some-persisted-secret\n");
    const binDir = path.join(dataDir, "stub-bin");
    fs.mkdirSync(binDir);
    const stubCat = path.join(binDir, "cat");
    fs.writeFileSync(stubCat, "#!/bin/sh\necho 'cat: simulated read failure' >&2\nexit 1\n");
    fs.chmodSync(stubCat, 0o755);

    const r = runEnsure(dataDir, {}, { pathPrefix: binDir });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("cannot read");
    expect(r.exported).toBe("");
  });

  it("write failure (unwritable data dir, no file) → non-zero, nothing exported", () => {
    // Root can write anywhere; skip the assertion in that case.
    if (typeof process.getuid === "function" && process.getuid() === 0) return;
    fs.chmodSync(dataDir, 0o500);
    try {
      const r = runEnsure(dataDir);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("failed to generate");
      expect(r.exported).toBe("");
    } finally {
      fs.chmodSync(dataDir, 0o700);
    }
  });

  it("uncreatable data dir → non-zero with stderr message", () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return;
    fs.chmodSync(dataDir, 0o500);
    try {
      const r = runEnsure(path.join(dataDir, "sub", "dir"));
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("cannot create data directory");
      expect(r.exported).toBe("");
    } finally {
      fs.chmodSync(dataDir, 0o700);
    }
  });

  it("does not leak umask or noclobber into the parent shell", () => {
    const r = runEnsure(dataDir, {}, {
      extraAfter: [
        `printf 'UMASK=%s\\n' "$(umask)"`,
        `case "$-" in *C*) echo 'NOCLOBBER=on' ;; *) echo 'NOCLOBBER=off' ;; esac`,
        `set -o | grep -i noclobber | tr -s ' \\t' ' ' | sed 's/^/SETO=/'`,
      ].join("\n"),
    });
    expect(r.status, r.stderr).toBe(0);
    // Default umask for the spawned sh — compare against a fresh shell.
    const baseline = spawnSync("sh", ["-c", "umask"], { encoding: "utf8" }).stdout.trim();
    expect(r.log).toContain(`UMASK=${baseline}`);
    expect(r.log).toContain("NOCLOBBER=off");
    expect(r.log).not.toMatch(/SETO=noclobber\s+on/);
    // The parent shell can still overwrite an existing file (noclobber really is off).
    const probe = spawnSync(
      "sh",
      ["-c", `. "${LIB}"; ensure_nextauth_secret >/dev/null; echo x > "${dataDir}/probe"; echo y > "${dataDir}/probe"`],
      { env: { NODE_ENV: process.env.NODE_ENV, PATH: process.env.PATH, CHORUS_DATA_DIR: dataDir }, encoding: "utf8" }
    );
    expect(probe.status).toBe(0);
    expect(fs.readFileSync(path.join(dataDir, "probe"), "utf8")).toBe("y\n");
  });

  it("docker-entrypoint.sh sources the library and calls ensure_nextauth_secret before the DB branch", () => {
    const src = fs.readFileSync(ENTRYPOINT, "utf8");
    const sourceIdx = src.indexOf(". /usr/local/bin/ensure-secret.sh");
    const callIdx = src.indexOf("ensure_nextauth_secret || exit 1");
    const dbIdx = src.indexOf('if [ -z "$DATABASE_URL" ]');
    const migrateIdx = src.indexOf("prisma migrate deploy");
    expect(sourceIdx).toBeGreaterThan(-1);
    expect(callIdx).toBeGreaterThan(sourceIdx);
    expect(dbIdx).toBeGreaterThan(callIdx);
    expect(migrateIdx).toBeGreaterThan(callIdx);
  });

  it("Dockerfile copies docker/ensure-secret.sh next to the entrypoint", () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, "Dockerfile"), "utf8");
    expect(src).toContain("COPY docker/ensure-secret.sh /usr/local/bin/");
    expect(src).toContain("COPY docker-entrypoint.sh /usr/local/bin/");
  });

  // ---------------------------------------------------------------------------
  // Review follow-ups (#559 round 2): fail closed on partial generation, and
  // install exclusively with `ln` instead of `rm -f` + noclobber.
  // ---------------------------------------------------------------------------

  it("source: generates into a same-dir temp file, validates 64-hex, installs with ln, no blanket rm -f / set -C", () => {
    const src = fs.readFileSync(LIB, "utf8");
    expect(src).toContain('_ens_tmp="$CHORUS_DATA_DIR/.secret.tmp.$$"');
    expect(src).toMatch(/\(\s*umask 077;\s*openssl rand -hex 32 > "\$_ens_tmp"\s*\)/);
    expect(src).toContain("grep -qxE '[0-9a-f]{64}'");
    expect(src).toContain('ln "$_ens_tmp" "$CHORUS_SECRET_FILE"');
    expect(src).not.toMatch(/^\s*set -C\b/m);
    // The only rm of the target must be guarded by the emptiness check on the same line.
    const rmTargetLines = src.split("\n").filter((l) => /rm -f "\$CHORUS_SECRET_FILE"/.test(l));
    expect(rmTargetLines).toHaveLength(1);
    const rmIdx = src.indexOf(rmTargetLines[0]);
    const guard = src.slice(Math.max(0, rmIdx - 200), rmIdx);
    expect(guard).toMatch(/if \[ -f "\$CHORUS_SECRET_FILE" \] && \[ -z "\$\(tr -d '\[:space:\]' < "\$CHORUS_SECRET_FILE"/);
    // The misleading race-safety comment is gone; the actual guarantee is stated.
    expect(src).not.toMatch(/noclobber.*race/i);
    expect(src).toMatch(/single-replica correctness/);
    expect(src).toMatch(/best-effort/);
  });

  const shells: Shell[] = busybox ? [HOST_SH, BUSYBOX_SH] : [HOST_SH];

  for (const shell of shells) {
    describe(`generator failure & race paths under ${shell.name}`, () => {
      it("openssl writes 1 byte then exits non-zero → rc≠0, nothing exported, no .secret, no temp file", () => {
        const r = runEnsure(dataDir, {}, { shell, prelude: "openssl(){ printf x; return 1; }" });
        expect(r.status).not.toBe(0);
        expect(r.exported).toBe("");
        expect(r.stderr).toContain("failed to generate");
        expect(r.log).not.toContain("generated a new random secret");
        expect(fs.existsSync(secretFile)).toBe(false);
        expect(fs.readdirSync(dataDir)).toEqual([]);
      });

      it("openssl exits 0 but output is not 64 lowercase hex → rc≠0, nothing exported, no .secret", () => {
        for (const bad of ["echo not-hex-at-all", "printf '%s' \"$(printf 'a%.0s' $(seq 1 63))\"", "echo ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789"]) {
          fs.rmSync(dataDir, { recursive: true, force: true });
          fs.mkdirSync(dataDir);
          const r = runEnsure(dataDir, {}, { shell, prelude: `openssl(){ ${bad}; return 0; }` });
          expect(r.status, bad).not.toBe(0);
          expect(r.exported, bad).toBe("");
          expect(r.stderr, bad).toContain("failed to generate");
          expect(fs.existsSync(secretFile), bad).toBe(false);
          expect(fs.readdirSync(dataDir), bad).toEqual([]);
        }
      });

      it("partial generation never replaces an existing empty .secret with garbage", () => {
        fs.writeFileSync(secretFile, "");
        const r = runEnsure(dataDir, {}, { shell, prelude: "openssl(){ printf x; return 1; }" });
        expect(r.status).not.toBe(0);
        expect(r.exported).toBe("");
        // The empty file is left as-is (unchanged), not overwritten with "x".
        expect(fs.readFileSync(secretFile, "utf8")).toBe("");
        expect(fs.readdirSync(dataDir)).toEqual([".secret"]);
      });

      it("a concurrent writer that installs a valid secret during generation wins; loser re-reads it", () => {
        const racer = "b".repeat(64);
        // Stub openssl: emit a valid 64-hex value AND simulate a competitor
        // having installed its own secret in the meantime.
        const prelude = `openssl(){ printf '%s\\n' "${racer}" > "${secretFile}"; printf '%s\\n' "$(printf 'c%.0s' $(seq 1 64))"; return 0; }`;
        const r = runEnsure(dataDir, {}, { shell, prelude });
        expect(r.status, r.stderr).toBe(0);
        expect(r.exported).toBe(racer);
        expect(fs.readFileSync(secretFile, "utf8").trim()).toBe(racer);
        expect(fs.readdirSync(dataDir)).toEqual([".secret"]); // temp file cleaned up
      });

      it("a competitor landing between the emptiness check and `ln` wins (ln is exclusive)", () => {
        const racer = "d".repeat(64);
        // Stub ln as a shell FUNCTION (BusyBox ash may resolve applets before
        // PATH, so a PATH stub is unreliable there): install the competitor's
        // secret first, then run the real ln, which must fail on the existing target.
        const prelude = `ln(){ printf '%s\\n' "${racer}" > "$2"; command ln "$@"; }`;
        const r = runEnsure(dataDir, {}, { shell, prelude });
        expect(r.status, r.stderr).toBe(0);
        expect(r.exported).toBe(racer);
        expect(fs.readFileSync(secretFile, "utf8").trim()).toBe(racer);
        expect(fs.readdirSync(dataDir)).toEqual([".secret"]);
      });

      it("N concurrent first starts on the same data dir all export the same secret", async () => {
        const N = 8;
        const script = [
          `. "${LIB}"`,
          `ensure_nextauth_secret >/dev/null 2>&1 || exit 1`,
          `printf '%s' "$NEXTAUTH_SECRET"`,
        ].join("\n");
        const env: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV, PATH: process.env.PATH, HOME: process.env.HOME, CHORUS_DATA_DIR: dataDir };
        const results = await Promise.all(
          Array.from({ length: N }, () =>
            new Promise<{ code: number | null; out: string }>((resolve) => {
              const child = spawn(shell.argv[0], [...shell.argv.slice(1), "-c", script], { env });
              let out = "";
              child.stdout.on("data", (d: Buffer) => (out += d.toString()));
              child.on("close", (code: number | null) => resolve({ code, out }));
            })
          )
        );
        for (const r of results) {
          expect(r.code).toBe(0);
          expect(r.out).toMatch(HEX64);
        }
        const distinct = new Set(results.map((r) => r.out));
        expect(distinct.size).toBe(1);
        expect(fs.readFileSync(secretFile, "utf8").trim()).toBe(results[0].out);
        expect(fs.statSync(secretFile).mode & 0o777).toBe(0o600);
        expect(fs.readdirSync(dataDir)).toEqual([".secret"]); // no leftover temp files
      });
    });
  }

  it.skipIf(!busybox)("busybox sh: happy path still generates 64-hex with mode 0600 and no umask leak", () => {
    const r = runEnsure(dataDir, {}, { shell: BUSYBOX_SH, extraAfter: `printf 'UMASK=%s\\n' "$(umask)"` });
    expect(r.status, r.stderr).toBe(0);
    expect(r.exported).toMatch(HEX64);
    expect(fs.statSync(secretFile).mode & 0o777).toBe(0o600);
    const baseline = spawnSync("busybox", ["sh", "-c", "umask"], { encoding: "utf8" }).stdout.trim();
    expect(r.log).toContain(`UMASK=${baseline}`);
  });
});
