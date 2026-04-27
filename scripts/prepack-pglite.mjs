/**
 * Dereference pnpm symlinks inside .next/standalone/ before npm pack.
 *
 * pnpm uses a content-addressable store with symlinks in node_modules/.
 * npm pack follows symlinks for `files` entries, but the resulting tarball
 * contains the pnpm .pnpm/ directory structure which breaks when installed
 * elsewhere. This script replaces symlinks with real copies inside the
 * Next.js standalone directory, then also copies the static assets and
 * public/ folder next to standalone/server.js.
 *
 * Root node_modules/ is NOT touched — runtime deps are resolved via
 * import.meta.resolve in chorus.mjs, so the user's package manager owns
 * installation (see issue #214 for context).
 */

import {
  cpSync,
  lstatSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";

function derefSymlink(target) {
  let stat;
  try {
    stat = lstatSync(target);
  } catch {
    return false;
  }
  if (!stat.isSymbolicLink()) return false;

  const realPath = realpathSync(target);
  rmSync(target, { force: true });
  cpSync(realPath, target, { recursive: true, dereference: true });
  return true;
}

// --- 1. Standalone node_modules: walk and dereference all symlinks ---

console.log("Dereferencing .next/standalone/node_modules symlinks...");
const standaloneNm = join(process.cwd(), ".next", "standalone", "node_modules");
let derefCount = 0;

function walkAndDeref(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);

    // Skip the .pnpm directory itself — we only want to deref the top-level
    // package symlinks that point into .pnpm/
    if (entry.name === ".pnpm") continue;

    let stat;
    try {
      stat = lstatSync(fullPath);
    } catch {
      continue;
    }

    if (stat.isSymbolicLink()) {
      if (derefSymlink(fullPath)) {
        derefCount++;
      }
    } else if (stat.isDirectory() && entry.name.startsWith("@")) {
      // Scoped packages: walk one level deeper
      walkAndDeref(fullPath);
    }
  }
}

walkAndDeref(standaloneNm);
console.log(`  dereferenced ${derefCount} symlinks`);

// --- 2. Remove the now-orphaned .pnpm directory ---

const pnpmDir = join(standaloneNm, ".pnpm");
try {
  rmSync(pnpmDir, { recursive: true, force: true });
  console.log("  removed .pnpm directory");
} catch {
  // ignore
}

// --- 3. Copy static assets and public/ into standalone directory ---
// Next.js standalone server.js expects .next/static/ and public/ relative
// to its own directory (.next/standalone/), but `next build` outputs them
// at the project root. Docker does this via COPY; we do it here for npm.

const standaloneDir = join(process.cwd(), ".next", "standalone");

console.log("Copying static assets into standalone directory...");
const staticSrc = join(process.cwd(), ".next", "static");
const staticDst = join(standaloneDir, ".next", "static");
cpSync(staticSrc, staticDst, { recursive: true });
console.log("  copied .next/static/");

const publicSrc = join(process.cwd(), "public");
const publicDst = join(standaloneDir, "public");
cpSync(publicSrc, publicDst, { recursive: true });
console.log("  copied public/");

console.log("Prepack complete.");
