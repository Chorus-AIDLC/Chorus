// Published CLI helper: builds the Chorus-managed Claude Code settings file that
// backs the `workspace` permission posture. PURE except for the explicit write
// step — `buildWorkspaceSettings` does no IO so it is unit-testable, and
// `writeWorkspaceSettings` is the only function that touches disk.
//
// Why a generated file rather than operator-authored settings: the posture needs
// four things to hold together (sandbox on, escape hatch off, excludedCommands
// empty, credentials still resolvable). Asking every operator to assemble that by
// hand means every operator rediscovers the same failure modes — and one missing
// key is a 403 retry loop rather than an error.
import { readFileSync, writeFileSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Settings keys copied verbatim from the operator's Claude Code settings so a
 * sandboxed wake can still authenticate. `--restricted` ignores user settings
 * entirely and `settings` is a managed control the per-agent `args` passthrough
 * rejects, so forwarding them through a generated file is the only route.
 *
 * This list is NECESSARILY incomplete: enterprise, OSS and third-party-gateway
 * builds name their credential hooks differently. That is why an explicit
 * override path exists — see `buildWorkspaceSettings`'s `authSettings`.
 */
export const FORWARDED_AUTH_KEYS = [
  "awsCredentialExport",
  "apiKeyHelper",
  "model",
  "fallbackModel",
  "modelOverrides",
  "availableModels",
  "enforceAvailableModels",
];

/** Env vars worth forwarding from the operator's settings `env` block (region/endpoint selection). */
export const FORWARDED_ENV_KEYS = [
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
];

/**
 * Home-relative paths denied to a workspace wake by default. Reads are NOT
 * restricted by the sandbox — only writes are — so without these a workspace
 * agent can read every credential on the machine, which contradicts what the
 * posture claims. Operators may append; they may also remove, because a task can
 * legitimately need one of these (writing deployment docs from `~/.aws/config`,
 * say) and overriding that judgement is not ours to make.
 */
export const DEFAULT_DENIED_READ_DIRS = [
  ".ssh",
  ".aws",
  ".gnupg",
  ".kube",
  ".docker",
  ".chorus",
  ".claude",
  ".config/gcloud",
  ".azure",
  ".netrc",
];

/**
 * Domains reachable by default. A workspace wake exists to deliver code, and most
 * real tasks need to install dependencies or talk to the forge; denying that by
 * default makes the first task fail, and an operator whose tasks do not run
 * switches back to yolo — which removes every restriction rather than one.
 *
 * Deliberately NOT paired with a deny-list of "common exfiltration targets":
 * that set cannot be enumerated, and a list that looks protective while missing
 * most of the space is worse than none.
 */
export const DEFAULT_ALLOWED_DOMAINS = [
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "github.com",
  "api.github.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
  "raw.githubusercontent.com",
  "pypi.org",
  "files.pythonhosted.org",
  "proxy.golang.org",
  "crates.io",
  "static.crates.io",
];

/** A non-empty trimmed string, or undefined. */
function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Read + parse JSON, or null on any failure (missing / unreadable / malformed). */
function readJsonSafe(path, read) {
  try {
    const parsed = JSON.parse(read(path));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Pick the credential-bearing subset of an operator settings object. Returns an
 * empty object when nothing matched, which the caller treats as "extraction
 * failed" — a sandboxed wake with no resolvable credentials retries 403 until it
 * is killed, so that case must surface as an error, never as a silent start.
 *
 * @param {Record<string, unknown> | null} settings
 * @returns {Record<string, unknown>}
 */
export function extractAuthSettings(settings) {
  if (!settings) return {};
  const picked = {};
  for (const key of FORWARDED_AUTH_KEYS) {
    if (settings[key] !== undefined) picked[key] = settings[key];
  }
  const env = settings.env;
  if (env && typeof env === "object" && !Array.isArray(env)) {
    const forwarded = {};
    for (const key of FORWARDED_ENV_KEYS) {
      if (typeof env[key] === "string") forwarded[key] = env[key];
    }
    if (Object.keys(forwarded).length) picked.env = forwarded;
  }
  return picked;
}

/**
 * True when this settings object can plausibly authenticate a session. A bare
 * `model` does not authenticate anything, so it is not sufficient on its own.
 * @param {Record<string, unknown>} auth
 */
export function hasUsableAuth(auth) {
  if (nonEmpty(auth.awsCredentialExport) || nonEmpty(auth.apiKeyHelper)) return true;
  const env = auth.env;
  if (env && typeof env === "object") {
    return Object.keys(env).some((k) => /^(CLAUDE_CODE_USE_|ANTHROPIC_)/.test(k));
  }
  return false;
}

/** Absolute `Read(...)` deny rules for the default sensitive paths, relative to a home dir. */
export function defaultDenyRules(home) {
  // Claude Code's permission rules use `//` for an absolute path; `sep` keeps
  // the probe correct on Windows, where the home dir is not under `/`.
  return DEFAULT_DENIED_READ_DIRS.map((dir) => `Read(//${join(home, dir).split(sep).filter(Boolean).join("/")}/**)`);
}

/**
 * Build the settings object for a workspace wake. No IO: `operatorSettings` and
 * `authSettings` are supplied by the caller.
 *
 * @param {{
 *   operatorSettings?: Record<string, unknown> | null,
 *   authSettings?: Record<string, unknown> | null,
 *   home?: string,
 *   extraDenyRules?: string[],
 *   extraAllowedDomains?: string[],
 * }} o
 * @returns {{ settings: Record<string, unknown>, auth: Record<string, unknown>, authSource: "explicit"|"extracted"|"none" }}
 */
export function buildWorkspaceSettings({
  operatorSettings = null,
  authSettings = null,
  home = homedir(),
  extraDenyRules = [],
  extraAllowedDomains = [],
} = {}) {
  // Explicit beats extracted: an operator who supplied a file did so because
  // extraction could not work for their build.
  const explicit = authSettings && Object.keys(authSettings).length ? authSettings : null;
  const auth = explicit ?? extractAuthSettings(operatorSettings);
  const authSource = explicit ? "explicit" : Object.keys(auth).length ? "extracted" : "none";

  const deny = [...defaultDenyRules(home), ...extraDenyRules];
  const allow = [...DEFAULT_ALLOWED_DOMAINS, ...extraAllowedDomains]
    .map((domain) => `WebFetch(domain:${domain})`);

  return {
    authSource,
    auth,
    settings: {
      ...auth,
      sandbox: {
        enabled: true,
        // Headless: nobody is there to answer a prompt, so a sandboxed command
        // must not raise one.
        autoAllowBashIfSandboxed: true,
        // Removes the `dangerouslyDisableSandbox` escape hatch from the Bash tool.
        allowUnsandboxedCommands: false,
        // Set explicitly rather than relying on the empty default: managed
        // settings still apply under a generated settings file, and a managed
        // `excludedCommands` would open an escape surface the operator cannot see.
        excludedCommands: [],
      },
      permissions: {
        // Not `auto`: the classifier would approve on its own, which is how the
        // allowlist-only posture came to be a no-op in the first place.
        defaultMode: "dontAsk",
        deny,
        allow,
      },
    },
  };
}

/**
 * Write a workspace settings file for one wake. Atomic (temp + rename) at 0600,
 * under a per-wake directory so concurrent wakes never share one.
 *
 * Throws when no credentials could be resolved: a workspace wake that cannot
 * authenticate retries 403 until killed, and that must look like a configuration
 * error, not a hang. The message names the override, because the operator cannot
 * guess which key their build needs.
 *
 * @param {{
 *   operatorSettingsPath?: string, authSettingsPath?: string, dir?: string,
 *   home?: string, extraDenyRules?: string[], extraAllowedDomains?: string[],
 * }} o
 * @param {{ read?: Function, write?: Function, mkdir?: Function, rename?: Function }} [deps]
 * @returns {{ path: string, authSource: "explicit"|"extracted", cleanup: () => void }}
 */
export function writeWorkspaceSettings(o = {}, deps = {}) {
  const read = deps.read ?? ((p) => readFileSync(p, "utf8"));
  const write = deps.write ?? writeFileSync;
  const mkdir = deps.mkdir ?? mkdirSync;
  const rename = deps.rename ?? renameSync;
  const remove = deps.rm ?? ((p) => rmSync(p, { recursive: true, force: true }));

  const operatorSettings = o.operatorSettingsPath ? readJsonSafe(o.operatorSettingsPath, read) : null;
  const authSettings = o.authSettingsPath ? readJsonSafe(o.authSettingsPath, read) : null;
  if (o.authSettingsPath && !authSettings) {
    throw new Error(
      `Chorus workspace mode: the settings file at ${o.authSettingsPath} is missing or not valid JSON. `
      + "It must contain the credential keys Claude Code needs (e.g. awsCredentialExport or apiKeyHelper).",
    );
  }

  const built = buildWorkspaceSettings({
    operatorSettings,
    authSettings,
    home: o.home,
    extraDenyRules: o.extraDenyRules,
    extraAllowedDomains: o.extraAllowedDomains,
  });

  if (!hasUsableAuth(built.auth)) {
    throw new Error(
      "Chorus workspace mode: no usable Claude Code credentials could be resolved. "
      + "`--restricted`-style sandboxing ignores user settings, so credentials must be forwarded explicitly; "
      + `the keys Chorus looks for are ${FORWARDED_AUTH_KEYS.join(", ")}. `
      + "Point `claudeSettingsPath` in ~/.chorus/daemon.json at a settings file that carries your build's "
      + "credential hook, or run the wake in yolo mode to accept full autonomy instead.",
    );
  }

  const dir = o.dir ?? join(tmpdir(), `chorus-workspace-${randomUUID()}`);
  const path = join(dir, "settings.json");
  const temp = `${path}.tmp`;
  mkdir(dirname(path), { recursive: true });
  write(temp, `${JSON.stringify(built.settings, null, 2)}\n`, { mode: 0o600 });
  rename(temp, path);

  return {
    path: resolve(path),
    authSource: /** @type {"explicit"|"extracted"} */ (built.authSource),
    // The file carries credential hooks; it must not outlive the wake.
    cleanup: () => remove(dir),
  };
}
