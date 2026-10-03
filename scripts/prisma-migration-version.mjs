import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const packages = ["prisma", "@prisma/client", "@prisma/adapter-pg"];
const stableVersion = /^7\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

// Read the installed packages rather than interpreting lockfile peer suffixes.
export function prismaMigrationVersion(root = process.cwd()) {
  const manifestPath = resolve(root, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const versions = packages.map((name) => {
    const declared = manifest.dependencies?.[name];
    if (typeof declared !== "string" || !stableVersion.test(declared)) {
      throw new Error(`${name} must have an exact stable Prisma 7.x pin`);
    }
    // These are direct dependencies installed by pnpm. Reading their metadata
    // follows pnpm's links without relying on private or CLI-only exports.
    const installed = JSON.parse(
      readFileSync(resolve(root, "node_modules", name, "package.json"), "utf8"),
    ).version;
    if (installed !== declared) {
      throw new Error(`${name}: installed ${installed} does not match pin ${declared}`);
    }
    return installed;
  });
  if (new Set(versions).size !== 1) {
    throw new Error("Prisma CLI, client and PostgreSQL adapter versions must match");
  }
  return versions[0];
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.stdout.write(`${prismaMigrationVersion()}\n`);
  } catch (error) {
    console.error(`Cannot select production migration CLI: ${error.message}`);
    process.exitCode = 1;
  }
}
