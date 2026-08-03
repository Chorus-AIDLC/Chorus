import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const DIRECTORY_ERROR_CODES = Object.freeze([
  "HOST_OFFLINE",
  "TIMEOUT",
  "INVALID_PATH",
  "OUTSIDE_ROOT",
  "NOT_DIRECTORY",
  "ACCESS_DENIED",
  "STALE_TARGET",
  "LIMIT_EXCEEDED",
  "INTERNAL_ERROR",
]);

export class DirectoryDiscoveryError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "DirectoryDiscoveryError";
    this.code = code;
  }
}

function expandHome(value, home, pathApi) {
  if (value === "~") return home;
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return pathApi.join(home, value.slice(2));
  }
  return value;
}

export function isPathWithin(root, candidate, pathApi = path) {
  const relative = pathApi.relative(pathApi.resolve(root), pathApi.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !pathApi.isAbsolute(relative));
}

function cursorIndex(cursor) {
  if (cursor == null || cursor === "") return 0;
  try {
    const parsed = Number(Buffer.from(cursor, "base64url").toString("utf8"));
    if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
  } catch {}
  throw new DirectoryDiscoveryError("INVALID_PATH", "Invalid directory cursor");
}

function fsError(err) {
  if (err?.code === "EACCES" || err?.code === "EPERM") return "ACCESS_DENIED";
  if (err?.code === "ENOTDIR") return "NOT_DIRECTORY";
  if (err?.code === "ENOENT") return "INVALID_PATH";
  return "INTERNAL_ERROR";
}

async function resolveRoots(roots, fsApi, pathApi) {
  try {
    return await Promise.all(roots.map(async (root) => ({
      lexical: root,
      real: await fsApi.realpath(root),
    })));
  } catch (err) {
    throw new DirectoryDiscoveryError(fsError(err));
  }
}

async function assertCanonicalWithin(candidate, roots, fsApi, pathApi) {
  const lexicalRoot = roots.find((root) =>
    isPathWithin(root.lexical, candidate, pathApi));
  if (!lexicalRoot) throw new DirectoryDiscoveryError("OUTSIDE_ROOT");

  let realCandidate;
  try {
    realCandidate = await fsApi.realpath(candidate);
  } catch (err) {
    throw new DirectoryDiscoveryError(fsError(err));
  }
  const relative = pathApi.relative(lexicalRoot.lexical, pathApi.resolve(candidate));
  const expected = pathApi.resolve(lexicalRoot.real, relative);
  if (realCandidate !== expected || !isPathWithin(lexicalRoot.real, realCandidate, pathApi)) {
    throw new DirectoryDiscoveryError("OUTSIDE_ROOT");
  }
  return realCandidate;
}

/**
 * Complete one path segment. Results intentionally contain only `{name,path}`.
 */
export async function discoverDirectories(options) {
  const pathApi = options.pathApi ?? path;
  const fsApi = options.fsApi ?? fs;
  const home = options.home ?? homedir();
  const maxScan = options.maxScan ?? 10_000;
  const maxResults = options.maxResults ?? 1_000;
  const maxLimit = options.maxLimit ?? 100;
  const timeoutMs = options.timeoutMs ?? 2_000;
  const limit = options.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > maxLimit) {
    throw new DirectoryDiscoveryError("LIMIT_EXCEEDED");
  }
  if (typeof options.prefix !== "string" || !options.prefix.trim()) {
    throw new DirectoryDiscoveryError("INVALID_PATH");
  }
  const expanded = expandHome(options.prefix.trim(), home, pathApi);
  if (!pathApi.isAbsolute(expanded)) throw new DirectoryDiscoveryError("INVALID_PATH");
  const normalized = pathApi.normalize(expanded);
  const parent = normalized.endsWith(pathApi.sep)
    ? normalized
    : pathApi.dirname(normalized);
  const namePrefix = normalized.endsWith(pathApi.sep) ? "" : pathApi.basename(normalized);
  const lexicalRoots = (options.browseRoots ?? []).map((root) => pathApi.resolve(root));
  if (!lexicalRoots.some((root) => isPathWithin(root, parent, pathApi))) {
    throw new DirectoryDiscoveryError("OUTSIDE_ROOT");
  }

  const scan = async () => {
    const roots = await resolveRoots(lexicalRoots, fsApi, pathApi);
    let parentStat;
    try {
      parentStat = await fsApi.lstat(parent);
      await fsApi.access(parent);
    } catch (err) {
      throw new DirectoryDiscoveryError(fsError(err));
    }
    if (parentStat.isSymbolicLink()) throw new DirectoryDiscoveryError("OUTSIDE_ROOT");
    if (!parentStat.isDirectory()) throw new DirectoryDiscoveryError("NOT_DIRECTORY");
    await assertCanonicalWithin(parent, roots, fsApi, pathApi);

    let entries;
    try {
      entries = await fsApi.readdir(parent, { withFileTypes: true });
    } catch (err) {
      throw new DirectoryDiscoveryError(fsError(err));
    }
    if (entries.length > maxScan) throw new DirectoryDiscoveryError("LIMIT_EXCEEDED");
    const matches = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".") || !entry.name.startsWith(namePrefix)) continue;
      const candidate = pathApi.resolve(parent, entry.name);
      if (!roots.some((root) => isPathWithin(root.lexical, candidate, pathApi))) continue;
      try {
        const stat = await fsApi.lstat(candidate);
        if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
        await fsApi.access(candidate);
        await assertCanonicalWithin(candidate, roots, fsApi, pathApi);
      } catch {
        continue;
      }
      matches.push({ name: entry.name, path: candidate });
      if (matches.length > maxResults) throw new DirectoryDiscoveryError("LIMIT_EXCEEDED");
    }
    matches.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.name.localeCompare(b.name));
    const start = cursorIndex(options.cursor);
    const items = matches.slice(start, start + limit);
    const next = start + items.length;
    return {
      items,
      nextCursor: next < matches.length
        ? Buffer.from(String(next), "utf8").toString("base64url")
        : null,
    };
  };

  let timer;
  try {
    return await Promise.race([
      scan(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new DirectoryDiscoveryError("TIMEOUT")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function validateDirectory(options) {
  const result = await discoverDirectories({
    ...options,
    prefix: options.cwd.endsWith(options.pathApi?.sep ?? path.sep)
      ? options.cwd
      : `${options.cwd}${options.pathApi?.sep ?? path.sep}`,
    limit: 1,
  });
  return { valid: true, normalizedPath: (options.pathApi ?? path).normalize(options.cwd), ...result };
}
