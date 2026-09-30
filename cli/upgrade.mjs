import * as fs from "node:fs";
import { dirname, posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { runUpgradeCommand, runUpgradeInstall, sanitizeUpgradeOutput, upgradeFailure } from "./upgrade-process.mjs";
// Eagerly load every collaborator before npm can replace this package.
import { upgradePlugins } from "./upgrade-plugins.mjs";

export const PACKAGE = "@chorus-aidlc/chorus";
const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const STABLE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
export const upgradeHelp = `Usage: chorus upgrade [--plugins]
       chorus update [--plugins]

Upgrade the active npm global Chorus installation to the latest stable release.
  --plugins   Also refresh Chorus plugins for configured daemon agents.
  -h, --help  Show help without checking or changing anything.

Exit 0: all requested work completed. Exit 1: failed or incomplete.
Source checkouts, linked installations and other package managers are unsupported.
`;

function newer(a, b) {
  const aa = a.split("+")[0].split(".").map(BigInt), bb = b.split("+")[0].split(".").map(BigInt);
  for (let i = 0; i < 3; i++) if (aa[i] !== bb[i]) return aa[i] > bb[i];
  return false;
}

export async function upgradeCli(deps = {}) {
  const io = deps.fs ?? fs;
  const platform = deps.platform ?? process.platform;
  const p = platform === "win32" ? win32 : posix;
  const env = deps.env ?? process.env;
  const run = deps.run ?? runUpgradeCommand;
  const root = deps.packageRoot ?? PACKAGE_ROOT;
  const same = (a, b) => platform === "win32"
    ? p.normalize(a).toLowerCase() === p.normalize(b).toLowerCase()
    : p.normalize(a) === p.normalize(b);
  const read = (path) => JSON.parse(io.readFileSync(path, "utf8"));
  const command = (args, timeoutMs = 30_000) => {
    const r = run("npm", args, { env, platform, timeoutMs });
    if (!r.ok) throw new Error(`npm ${args[0]} ${upgradeFailure(r, { env })}`);
    return String(r.stdout).trim();
  };
  const explain = (error) => sanitizeUpgradeOutput(error?.message, { env });
  let prefix, installed, current, latest;
  try {
    prefix = command(["prefix", "-g"]);
    const globalRoot = command(["root", "-g"]);
    const expectedRoot = platform === "win32" ? p.join(prefix, "node_modules") : p.join(prefix, "lib", "node_modules");
    installed = p.join(globalRoot, "@chorus-aidlc", "chorus");
    if (!p.isAbsolute(prefix) || !p.isAbsolute(globalRoot) ||
        !same(io.realpathSync(globalRoot), io.realpathSync(expectedRoot)) ||
        io.lstatSync(installed).isSymbolicLink() || io.existsSync(p.join(installed, ".git")) ||
        !same(io.realpathSync(root), io.realpathSync(installed))) throw new Error();
    const pkg = read(p.join(root, "package.json"));
    const listing = JSON.parse(command(["ls", "-g", PACKAGE, "--depth=0", "--json", "--long"]));
    const entry = listing.dependencies?.[PACKAGE];
    if (pkg.name !== PACKAGE || !STABLE.test(pkg.version) || !entry ||
        entry.name !== PACKAGE || entry.version !== pkg.version || !entry.path ||
        !same(io.realpathSync(entry.path), io.realpathSync(installed)) ||
        entry.link || entry.isLink || entry.invalid || entry.extraneous || entry.problems?.length) throw new Error();
    // npm versions differ in which provenance fields they retain. When present,
    // refuse file/git/link sources; repository metadata is NOT install provenance.
    for (const meta of [pkg, entry]) {
      const source = meta.resolved ?? meta._resolved;
      if (source && !/^https?:\/\/[^?#]+\.tgz(?:\?.*)?$/.test(source)) throw new Error();
      if (meta._from && !/^@chorus-aidlc\/chorus@[\w.*~^<>= |+-]+$/.test(meta._from)) throw new Error();
    }
    current = pkg.version;
  } catch (error) {
    return { complete: false, changed: false, detail: `Cannot verify this npm global installation. ${explain(error)}\nUse npm install -g @chorus-aidlc/chorus@latest with the intended npm prefix; source/link/other-manager installs are unsupported.` };
  }
  try {
    latest = JSON.parse(command(["view", `${PACKAGE}@latest`, "version", "--json"]));
    if (typeof latest !== "string" || !STABLE.test(latest)) throw new Error();
  } catch (error) {
    return { complete: false, changed: false, detail: `Latest stable version discovery failed (npm registry/network/timeout or invalid version). ${explain(error)}` };
  }
  if (!newer(latest, current)) {
    return { complete: true, changed: false, detail: `CLI ${current} is current${current !== latest ? ` (latest stable ${latest}; no downgrade)` : ""}.` };
  }
  try {
    deps.log?.(`Installing CLI ${current} → ${latest}; npm progress follows (no installation timeout).`);
    const result = await (deps.runInstall ?? deps.run ?? runUpgradeInstall)(
      "npm", ["install", "-g", `${PACKAGE}@${latest}`, "--prefix", prefix, "--no-audit", "--no-fund", "--yes"],
      { env, platform, onOutput: (line) => deps.log?.(sanitizeUpgradeOutput(line, { env })) },
    );
    if (!result.ok) throw new Error(upgradeFailure(result, { env }));
  } catch (error) {
    const reason = explain(error);
    const permission = /\bEACCES\b|\bEPERM\b|permission denied/i.test(reason)
      ? " Permission denied: use a user-owned Node installation (for example nvm), or ask the administrator to update the system npm prefix; no automatic elevation is attempted."
      : "";
    return { complete: false, changed: true, detail: `CLI install failed (${current} → ${latest}): ${reason}.${permission} Inspect the npm installation before retrying.` };
  }
  try {
    const pkg = read(p.join(installed, "package.json"));
    if (pkg.name !== PACKAGE || pkg.version !== latest) throw new Error();
  } catch {
    return { complete: false, changed: true, detail: `CLI version verification failed; expected ${latest}.` };
  }
  return { complete: true, changed: true, detail: `CLI upgraded ${current} → ${latest} (installed version verified).` };
}

export async function runUpgrade(argv = [], deps = {}) {
  const log = deps.log ?? console.log;
  if (argv.some((a) => !["--plugins", "--help", "-h"].includes(a))) {
    log("Invalid upgrade arguments. Use chorus upgrade --help.");
    return 1;
  }
  if (argv.includes("--help") || argv.includes("-h")) { log(upgradeHelp); return 0; }
  const cli = await upgradeCli({ ...deps, log });
  log(cli.detail);
  let complete = cli.complete, changed = cli.changed;
  if (complete && argv.includes("--plugins")) {
    const results = await (deps.upgradePlugins ?? upgradePlugins)(deps);
    for (const r of results) {
      log(`${r.target}: ${r.complete ? "OK" : "INCOMPLETE"} — ${r.detail}`);
      complete &&= r.complete;
      changed ||= r.changed;
    }
  }
  if (changed) log("Start new agent sessions to load updated plugins; restart the Chorus daemon when convenient. Active sessions were not restarted.");
  return complete ? 0 : 1;
}
