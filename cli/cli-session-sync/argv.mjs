// cli/cli-session-sync/argv.mjs
// Small, backend-neutral argv helpers shared by the session-sync adapters' inspectArgs.
// Pure functions; no backend knowledge lives here (each adapter passes its own verified
// flag tables).

/** Tokens before the agent's own `--` separator (only those are options). */
export function optionTokens(args) {
  const list = Array.isArray(args) ? args : [];
  const end = list.indexOf("--");
  return end === -1 ? list : list.slice(0, end);
}

/** `--name=value` → `--name`; other tokens unchanged. */
export function flagName(tok) {
  if (typeof tok !== "string" || !tok.startsWith("--")) return tok;
  const eq = tok.indexOf("=");
  return eq === -1 ? tok : tok.slice(0, eq);
}

/**
 * Walk option tokens, skipping the value of every flag in `valueFlags` (space form only;
 * `--flag=value` / `-Xvalue` carry their own value). Collects `{ tok, name, index }` for
 * EVERY flag (CLIs accept flags after positionals) and the first non-flag token.
 * @param {string[]} opts
 * @param {Set<string>} valueFlags  flags that consume the following token
 * @returns {{ flags: Array<{ tok: string, name: string, index: number }>, positional: string|null }}
 */
export function scanOptions(opts, valueFlags) {
  const flags = [];
  let positional = null;
  for (let i = 0; i < opts.length; i += 1) {
    const tok = opts[i];
    if (typeof tok !== "string") continue;
    if (!tok.startsWith("-") || tok === "-") {
      positional ??= tok;
      continue;
    }
    const name = flagName(tok);
    flags.push({ tok, name, index: i });
    if (valueFlags.has(name) && !tok.includes("=")) i += 1;
  }
  return { flags, positional };
}
