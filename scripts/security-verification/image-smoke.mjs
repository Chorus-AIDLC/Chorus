import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const loadPackage = createRequire(import.meta.url);
const wanted = new Set(["next", "react", "react-dom", "prisma", "@prisma/client", "@prisma/adapter-pg", "postcss", "nanoid", "sharp"]);
const packages = {};
function walk(dir) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, item.name);
    if (item.isDirectory()) walk(file);
    if (item.isFile() && item.name === "package.json") {
      try {
        const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
        if (wanted.has(pkg.name) && pkg.version) {
          (packages[pkg.name] ??= []).push({ version: pkg.version, path: file });
        }
      } catch {}
    }
  }
}
(async () => {
  walk("/app/node_modules");
  walk("/root/.local/share/pnpm/global");
  const manifest = JSON.parse(fs.readFileSync("/app/package.json", "utf8"));
  for (const name of ["prisma", "@prisma/client", "@prisma/adapter-pg"]) {
    if (manifest.dependencies[name] !== "7.10.0") throw new Error(name + " manifest pin mismatch");
  }
  for (const name of ["prisma", "@prisma/client"]) {
    if (!packages[name]?.some(p => p.version === "7.10.0") || packages[name].some(p => p.version !== "7.10.0")) {
      throw new Error(name + " installed metadata mismatch: " + JSON.stringify(packages[name]));
    }
  }
  const sharp = loadPackage(path.dirname(packages.sharp.find(p => p.version === "0.35.5").path));
  if (sharp.versions.sharp !== "0.35.5") throw new Error("Unexpected sharp");
  const images = {};
  for (const format of ["png", "webp", "avif"]) {
    const data = await sharp({ create: { width: 24, height: 18, channels: 4, background: "#7c3aed" } }).resize(12, 9).toFormat(format).toBuffer();
    const metadata = await sharp(data).metadata();
    if (metadata.width !== 12 || metadata.height !== 9) throw new Error("Image dimensions mismatch");
    images[format] = { bytes: data.length, format: metadata.format, width: metadata.width, height: metadata.height };
  }
  process.stdout.write(JSON.stringify({ architecture: process.arch, node: process.version, packages, sharpVersions: sharp.versions, images, passed: true }, null, 2) + "\n");
})().catch(error => { process.stderr.write(error.stack + "\n"); process.exitCode = 1; });
