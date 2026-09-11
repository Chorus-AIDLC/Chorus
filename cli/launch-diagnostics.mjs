// Child-process error messages, paths, argv, code and syscall are untrusted.
// Only emit known classifications for spawn failures; never echo raw fields.
const SPAWN_CODES = new Map([
  ["ENOENT", "executable or working directory not found; check PATH and cwd"],
  ["EACCES", "permission denied; check executable and directory permissions"],
  ["EPERM", "operation not permitted; check process permissions"],
  ["ENOEXEC", "invalid executable format; check the installed binary"],
  ["ENOTDIR", "path component is not a directory; check executable path and cwd"],
  ["EINVAL", "invalid process options; check executable and launch configuration"],
  ["E2BIG", "argument/environment size limit exceeded; reduce configuration size"],
  ["ENOMEM", "insufficient memory to start process"],
  ["EAGAIN", "process resource limit reached; retry or check system limits"],
  ["EMFILE", "process file descriptor limit reached"],
  ["ENFILE", "system file descriptor limit reached"],
  ["ETIMEDOUT", "process startup timed out"],
]);

export function safeSpawnError(error) {
  const code = error?.code;
  return typeof code === "string" && SPAWN_CODES.has(code)
    ? `${code}: ${SPAWN_CODES.get(code)}`
    : "unclassified startup failure; check executable installation, PATH, cwd and permissions";
}

// Setup stderr can embed arbitrary argv/env in JSON, escaped nested errors,
// URLs, or encodings we cannot enumerate. Substring replacement is NOT a safe
// output boundary. Classify known problems, but render only these fixed strings
// (never captures, original text, paths, codes, or even a "redacted" remainder).
// Keep the patterns recognizable in our own output: setup and spawner both call
// this helper, and the second boundary must retain the first one's useful hints.
const SETUP_HINTS = [
  [/version mismatch/i, "version mismatch; check dsh runtime and Chorus bundle compatibility"],
  [/no adapter registered/i, "no adapter registered; check that the selected provider adapter is installed"],
  [/invalid plugin graph/i, "invalid plugin graph; rebuild the sdk profile and check plugin compatibility"],
  [/bad key|unauthorized|authentication failed/i, "authentication failed; check provider and Chorus credentials"],
  [/ERR_PNPM.*offline|package registry unavailable/i, "package registry unavailable; check network access and pnpm registry configuration"],
  [/bundle version/i, "bundle version required; check the installed Chorus version"],
  [/requires the dsh CLI|dsh CLI was not found|dsh CLI required/i, "dsh CLI required; install dsh or set CHORUS_DSH_PATH"],
  [/missing.*bundle layer/i, "missing Chorus bundle layer; rebuild the managed sdk profile"],
  [/did not install|Chorus bundle not installed/i, "Chorus bundle not installed; check package installation and rebuild the managed sdk profile"],
  [/did not complete JSON-RPC initialization/i, "did not complete JSON-RPC initialization; check the dsh sdk profile and runtime compatibility"],
  [/unexpected server identity/i, "unexpected server identity; check that the sdk profile loads the expected dsh runtime"],
];
const SETUP_CODES = new Map([
  ...SPAWN_CODES,
  ["ENOSPC", "disk full; free space for the managed profile"],
  ["EROFS", "read-only filesystem; use a writable managed profile home"],
]);
const SETUP_FALLBACK = "unclassified setup failure; check dsh installation, sdk profile, provider adapter, package registry and filesystem permissions (raw details withheld)";

export function redactedSetupError(error) {
  const text = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const stages = [];
  if (/profile installation failed/i.test(text)) stages.push("dsh managed profile installation failed");
  if (/composition validation failed/i.test(text)) stages.push("dsh managed composition validation failed");
  if (/non-default provider/i.test(text)) {
    stages.push("a non-default provider is configured; the managed sdk profile mounts only the deepseek-official adapter; pre-compose its adapter and point CHORUS_DSH_HOME at your own sdk profile");
  }
  const hints = [];
  for (const [code, hint] of SETUP_CODES) {
    if (error?.code === code || new RegExp(`\\b${code}\\b`).test(text)) hints.push(`${code}: ${hint}`);
  }
  for (const [pattern, hint] of SETUP_HINTS) {
    if (pattern.test(text)) hints.push(hint);
  }
  return [...stages, hints.length ? hints.join("; ") : SETUP_FALLBACK].join(": ");
}
