// Bash < 4.4 (macOS /bin/bash 3.2) treats "${arr[@]}" of an EMPTY array as an
// unbound variable under `set -u`. Plugin shell scripts run with `set -euo pipefail`,
// so every array that may legitimately stay empty (initialised with `name=()`) must
// be expanded as ${name[@]+"${name[@]}"}.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");
const SCRIPTS = [
  "public/chorus-plugin/bin/chorus-api.sh",
  "public/kiro-plugin/bin/chorus-api.sh",
  "plugins/chorus/hooks/chorus-mcp-call.sh",
  "packages/chorus-pi/bin/chorus-mcp-call.sh",
];

describe("plugin shell scripts are safe for empty arrays under Bash 3.2", () => {
  for (const script of SCRIPTS) {
    it(script, () => {
      const source = readFileSync(resolve(ROOT, script), "utf8");
      const emptyArrays = [...source.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)=\(\)/gm)].map((match) => match[1]);
      expect(emptyArrays.length).toBeGreaterThan(0);
      for (const name of emptyArrays) {
        const unguarded = source.split("\n").filter((line) => line.includes(`"\${${name}[@]}"`) && !line.includes(`\${${name}[@]+"\${${name}[@]}"}`));
        expect(unguarded, `${name} expanded without a Bash 3.2 guard`).toEqual([]);
      }
    });
  }
});
