import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The dsh MCP wrapper (bin/chorus-mcp-call.mjs) prefers the native `chorus` CLI
// when it is on PATH and falls back to its built-in Node MCP transport otherwise
// — the same prefer-CLI / fallback contract the bash wrappers apply. This drives
// the real script as a subprocess with a fake `chorus` on PATH and asserts each
// branch. POSIX-only (the fake is a shebang shell script); skipped on Windows.
const WRAPPER = fileURLToPath(new URL("../bin/chorus-mcp-call.mjs", import.meta.url));

const URL_ARG = "http://127.0.0.1:1"; // guaranteed-unreachable -> native fetch fails fast
const KEY_ARG = "cho_testkey";
const TOOL = "chorus_checkin";
const JSON_ARG = '{"foo":"bar"}';
const EXPECTED_ARGS = `mcp call ${TOOL} ${JSON_ARG} --url ${URL_ARG} --api-key ${KEY_ARG}`;
// Profile-path (CHORUS_AGENT_PROFILE) expectations. A real agentName with a space
// proves the wrapper forwards it as ONE argv element (spawnSync argv is an array,
// and the fake joins argv with spaces).
const PROFILE = "Admin Claude";
const EXPECTED_PROFILE_ARGS = `mcp call ${TOOL} ${JSON_ARG} --agent ${PROFILE}`;

describe.skipIf(process.platform === "win32")("dsh chorus-mcp-call prefer-CLI/fallback", () => {
  let root: string;
  let fakeBin: string;
  let cleanBin: string;
  let argsFile: string;
  let markerFile: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "dsh-mcp-deleg-"));
    fakeBin = join(root, "fakebin");
    cleanBin = join(root, "cleanbin"); // empty -> `chorus` absent
    mkdirSync(fakeBin);
    mkdirSync(cleanBin);
    argsFile = join(root, "fake-args");
    markerFile = join(root, "fake-marker");

    // Fake `chorus`: `--version` prints $CHORUS_FAKE_VERSION (a chosen X.Y.Z, or
    // garbage to exercise the unparseable branch) and exits 0 WITHOUT touching the
    // marker/args — so the marker proves a real `chorus mcp call`, never a version
    // probe. Any other argv records argv + a marker, then succeeds (sentinel on
    // stdout) or fails (exit 7, sentinel on stderr) per $CHORUS_FAKE_MODE.
    const fake = join(fakeBin, "chorus");
    writeFileSync(
      fake,
      [
        "#!/usr/bin/env bash",
        'if [ "$1" = "--version" ]; then',
        "  printf '%s\\n' \"${CHORUS_FAKE_VERSION:-0.17.0}\"",
        "  exit 0",
        "fi",
        'printf \'%s\\n\' "$*" > "$CHORUS_FAKE_ARGS"',
        ': > "$CHORUS_FAKE_MARKER"',
        'if [ "${CHORUS_FAKE_MODE:-ok}" = "fail" ]; then',
        "  printf 'CHORUS_CLI_SENTINEL_FAIL\\n' >&2",
        "  exit 7",
        "fi",
        "printf 'CHORUS_CLI_SENTINEL_OK\\n'",
        "exit 0",
        "",
      ].join("\n"),
    );
    chmodSync(fake, 0o755);
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function run(opts: { pathVal: string; mode?: string; noCli?: boolean; version?: string }) {
    rmSync(argsFile, { force: true });
    rmSync(markerFile, { force: true });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: opts.pathVal,
      CHORUS_URL: URL_ARG,
      CHORUS_API_KEY: KEY_ARG,
      CHORUS_FAKE_MODE: opts.mode ?? "ok",
      // Default the stubbed `chorus --version` to a supported release so the
      // delegation cases exercise the >= 0.17.0 branch (package.json is 0.16.4
      // pre-release, so we must NOT rely on the real CLI version here).
      CHORUS_FAKE_VERSION: opts.version ?? "0.17.0",
      CHORUS_FAKE_ARGS: argsFile,
      CHORUS_FAKE_MARKER: markerFile,
    };
    if (opts.noCli) env.CHORUS_MCP_NO_CLI = "1";
    else delete env.CHORUS_MCP_NO_CLI;
    return spawnSync(process.execPath, [WRAPPER, TOOL, JSON_ARG], { env, encoding: "utf8" });
  }

  const withReal = (dir: string) => `${dir}${delimiter}${process.env.PATH ?? ""}`;

  it("A: delegates to `chorus mcp call` (verbatim stdout, explicit creds, exit 0)", () => {
    const r = run({ pathVal: withReal(fakeBin), mode: "ok" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("CHORUS_CLI_SENTINEL_OK");
    expect(readFileSync(argsFile, "utf8").trim()).toBe(EXPECTED_ARGS);
  });

  it("B: propagates a failing CLI exit (7) and stderr — no fetch fallback", () => {
    const r = run({ pathVal: withReal(fakeBin), mode: "fail" });
    expect(r.status).toBe(7);
    expect(r.stderr).toContain("CHORUS_CLI_SENTINEL_FAIL");
  });

  it("C: CHORUS_MCP_NO_CLI escape hatch bypasses the CLI (native path)", () => {
    const r = run({ pathVal: withReal(fakeBin), mode: "ok", noCli: true });
    // Fake never ran (no marker) and no delegated stdout.
    expect(() => readFileSync(markerFile, "utf8")).toThrow();
    expect(r.stdout).not.toContain("CHORUS_CLI_SENTINEL_OK");
    // Native transport hit the unreachable URL and failed loudly.
    expect(r.status).not.toBe(0);
  });

  it("D: `chorus` absent -> native transport (no delegation)", () => {
    const r = run({ pathVal: cleanBin, mode: "ok" });
    expect(() => readFileSync(markerFile, "utf8")).toThrow();
    expect(r.stdout).not.toContain("CHORUS_CLI_SENTINEL_OK");
    expect(r.status).not.toBe(0);
  });

  it("E: version >= 0.17.0 (1.2.0, major>0) still delegates", () => {
    const r = run({ pathVal: withReal(fakeBin), mode: "ok", version: "1.2.0" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("CHORUS_CLI_SENTINEL_OK");
    expect(readFileSync(argsFile, "utf8").trim()).toBe(EXPECTED_ARGS);
  });

  it("F: too-old chorus (0.16.4) -> upgrade error, non-zero, no delegation, no native fallback", () => {
    const r = run({ pathVal: withReal(fakeBin), mode: "ok", version: "0.16.4" });
    expect(r.status).not.toBe(0);
    // never delegated `chorus mcp call` (no marker written)
    expect(() => readFileSync(markerFile, "utf8")).toThrow();
    expect(r.stdout).not.toContain("CHORUS_CLI_SENTINEL_OK");
    // actionable upgrade error naming the floor + the npm command; the presence of
    // this exact message also proves it did NOT silently fall through to the native
    // transport (which would have hit the unreachable URL and errored differently).
    expect(r.stderr).toContain("requires chorus >= 0.17.0");
    expect(r.stderr).toContain("npm install -g @chorus-aidlc/chorus");
  });

  it("G: unparseable version -> same upgrade error, non-zero, no delegation", () => {
    const r = run({ pathVal: withReal(fakeBin), mode: "ok", version: "not-a-version" });
    expect(r.status).not.toBe(0);
    expect(() => readFileSync(markerFile, "utf8")).toThrow();
    expect(r.stderr).toContain("npm install -g @chorus-aidlc/chorus");
  });

  // ---- profile path (CHORUS_AGENT_PROFILE) --------------------------------
  // The profile is NOT credential-shaped, so dsh does not scrub it: dsh loads
  // $DSH_HOME/.env into the session and it reaches the wrapper on the process env.
  // The wrapper therefore reads CHORUS_AGENT_PROFILE from process.env ONLY and does
  // NOT re-read $DSH_HOME/.env for it (that fallback exists for the scrubbed
  // url/apiKey). profileVia: "env" sets it on the env; "dotenv" writes it (with
  // url+key) into $DSH_HOME/.env but NOT the env, proving the wrapper ignores the
  // file copy of the profile and falls back to url+key delegation.
  function runProfile(opts: {
    pathVal: string;
    profileVia?: "env" | "dotenv";
    withUrlKey?: boolean;
    version?: string;
  }) {
    rmSync(argsFile, { force: true });
    rmSync(markerFile, { force: true });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: opts.pathVal,
      CHORUS_FAKE_MODE: "ok",
      CHORUS_FAKE_VERSION: opts.version ?? "0.17.0",
      CHORUS_FAKE_ARGS: argsFile,
      CHORUS_FAKE_MARKER: markerFile,
    };
    delete env.CHORUS_MCP_NO_CLI;
    delete env.CHORUS_URL;
    delete env.CHORUS_API_KEY;
    delete env.CHORUS_AGENT_PROFILE;
    delete env.DSH_HOME;
    if (opts.withUrlKey) {
      env.CHORUS_URL = URL_ARG;
      env.CHORUS_API_KEY = KEY_ARG;
    }
    if (opts.profileVia === "dotenv") {
      // Profile (and creds) live ONLY in $DSH_HOME/.env, never on the process env.
      const dshHome = mkdtempSync(join(root, "dsh-home-"));
      writeFileSync(
        join(dshHome, ".env"),
        `FOO=bar\nCHORUS_URL=${URL_ARG}\nCHORUS_API_KEY=${KEY_ARG}\nCHORUS_AGENT_PROFILE=${PROFILE}\n`,
      );
      env.DSH_HOME = dshHome;
    } else {
      env.CHORUS_AGENT_PROFILE = PROFILE;
      // Point DSH_HOME at an EMPTY dir so readDshHomeEnv() can never pick up a real
      // ~/.dsh/.env on the dev machine (this is the env-only profile path, with no
      // file-based creds); deleting DSH_HOME would fall back to ~/.dsh.
      env.DSH_HOME = mkdtempSync(join(root, "dsh-empty-"));
    }
    return spawnSync(process.execPath, [WRAPPER, TOOL, JSON_ARG], { env, encoding: "utf8" });
  }

  it("H: CHORUS_AGENT_PROFILE (env) + usable CLI, NO url/key -> delegates `--agent <profile>`", () => {
    const r = runProfile({ pathVal: withReal(fakeBin), profileVia: "env" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("CHORUS_CLI_SENTINEL_OK");
    expect(readFileSync(argsFile, "utf8").trim()).toBe(EXPECTED_PROFILE_ARGS);
  });

  it("I: profile is PREFERRED over url+key when both are present", () => {
    const r = runProfile({ pathVal: withReal(fakeBin), profileVia: "env", withUrlKey: true });
    expect(r.status).toBe(0);
    expect(readFileSync(argsFile, "utf8").trim()).toBe(EXPECTED_PROFILE_ARGS);
  });

  it("J: profile in $DSH_HOME/.env is NOT read — wrapper uses .env url+key (delegates --url/--api-key, never --agent)", () => {
    const r = runProfile({ pathVal: withReal(fakeBin), profileVia: "dotenv" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("CHORUS_CLI_SENTINEL_OK");
    const args = readFileSync(argsFile, "utf8").trim();
    // url+key from .env drive delegation; the profile in .env is ignored (it would
    // be `--agent <profile>` if the wrapper still read the profile from the file).
    expect(args).toBe(EXPECTED_ARGS);
    expect(args).not.toContain("--agent");
  });

  it("K: profile set but `chorus` absent + no url/key -> clear 'requires it' error, exit 1", () => {
    const r = runProfile({ pathVal: cleanBin, profileVia: "env" });
    expect(r.status).toBe(1);
    expect(() => readFileSync(markerFile, "utf8")).toThrow(); // never delegated
    expect(r.stderr).toContain("CHORUS_AGENT_PROFILE is set");
    expect(r.stderr).toContain("npm install -g @chorus-aidlc/chorus");
  });
});

// T6 gateway BLOCKER — regression + fix. With `chorus` OFF PATH and NO CHORUS_* in
// the environment (dsh scrubs credential-shaped vars from tool subprocesses), the
// wrapper's ONLY credential source is $DSH_HOME/.env — the channel `chorus init`
// now seeds for a dsh agent (formerly written by the retired dsh-credentials.sh).
// Without that .env the wrapper prints "…not set" and exits 1 (the reproduced
// failure); with it, credentials resolve and the wrapper proceeds to its native
// transport. POSIX-only (fake bin dir on PATH); skipped on Windows.
describe.skipIf(process.platform === "win32")("dsh chorus-mcp-call $DSH_HOME/.env credential fallback", () => {
  let root: string;
  let cleanBin: string; // empty dir on PATH -> `chorus` absent

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "dsh-mcp-envcred-"));
    cleanBin = join(root, "cleanbin");
    mkdirSync(cleanBin);
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // Run the wrapper with `chorus` absent (empty PATH dir + CHORUS_MCP_NO_CLI=1 to
  // force the native transport) and NO CHORUS_* env, so credentials can ONLY come
  // from $DSH_HOME/.env.
  function runWithDshHome(dshHome: string) {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.CHORUS_URL;
    delete env.CHORUS_API_KEY;
    env.PATH = cleanBin; // `chorus` not resolvable on PATH
    env.CHORUS_MCP_NO_CLI = "1"; // force the native transport path
    env.DSH_HOME = dshHome;
    return spawnSync(process.execPath, [WRAPPER, TOOL, JSON_ARG], { env, encoding: "utf8" });
  }

  it("E1 (reproduces the BLOCKER): no .env + no CHORUS_* env -> 'not set', exit 1", () => {
    const emptyHome = mkdtempSync(join(tmpdir(), "dsh-home-empty-"));
    const r = runWithDshHome(emptyHome);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("CHORUS_URL or CHORUS_API_KEY not set");
    rmSync(emptyHome, { recursive: true, force: true });
  });

  it("E2 (the fix): a seeded $DSH_HOME/.env resolves creds -> no 'not set', proceeds past the gate", () => {
    const dshHome = mkdtempSync(join(tmpdir(), "dsh-home-seeded-"));
    // Exactly the dotenv shape `chorus init` writes for a dsh agent (plus an
    // unrelated line, to mirror a real merge-preserving .env).
    writeFileSync(
      join(dshHome, ".env"),
      `# chorus\nFOO=bar\nCHORUS_URL=${URL_ARG}\nCHORUS_API_KEY=cho_from_env\n`,
    );
    const r = runWithDshHome(dshHome);
    // The credential gate PASSED — the reproduced failure is gone.
    expect(r.stderr).not.toContain("CHORUS_URL or CHORUS_API_KEY not set");
    expect(r.status).not.toBe(1);
    // It proceeded to the native transport, which failed loudly on the unreachable URL.
    expect(r.status).not.toBe(0);
    rmSync(dshHome, { recursive: true, force: true });
  });
});
