#!/usr/bin/env node
/* ============================================================
   sparkBook · scripts/check-version-sync.mjs

   Fails when the three version declarations disagree.

   Why this is a build gate and not a nicety: tauri-action builds
   the artifact and writes latest.json from src-tauri/tauri.conf.json.
   If a release is tagged v0.3.3 while tauri.conf.json still says
   0.3.2, the release is *named* 0.3.3 but ships a 0.3.2 binary and
   a manifest advertising 0.3.2. Clients then "update successfully"
   and come back reporting the old number — the version never
   changes, and nothing in the pipeline complains.

   Run standalone, or with --tag vX.Y.Z to also require the git tag
   to match (the release workflow does this).
   ============================================================ */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function read(path) {
  try {
    return readFileSync(join(root, path), "utf8");
  } catch (err) {
    throw new Error(`cannot read ${path}: ${err.message}`);
  }
}

const sources = [];

sources.push({
  file: "package.json",
  version: JSON.parse(read("package.json")).version,
});

sources.push({
  file: "src-tauri/tauri.conf.json",
  version: JSON.parse(read("src-tauri/tauri.conf.json")).version,
});

// The [package] version specifically — a `version = "2"` on a
// dependency further down the file must not be mistaken for it.
const cargo = read("src-tauri/Cargo.toml");
const packageSection = /^\[package\]\s*$([\s\S]*?)(?=^\[|\Z)/m.exec(cargo)?.[1] ?? "";
const cargoVersion = /^\s*version\s*=\s*"([^"]+)"/m.exec(packageSection)?.[1];
sources.push({ file: "src-tauri/Cargo.toml", version: cargoVersion });

const missing = sources.filter((s) => !s.version);
if (missing.length) {
  console.error(`✗ could not read a version from: ${missing.map((m) => m.file).join(", ")}`);
  process.exit(1);
}

const tagArgIndex = process.argv.indexOf("--tag");
if (tagArgIndex !== -1) {
  const tag = process.argv[tagArgIndex + 1];
  if (tag) sources.push({ file: `git tag ${tag}`, version: tag.replace(/^v/, "") });
}

const distinct = [...new Set(sources.map((s) => s.version))];

if (distinct.length === 1) {
  console.log(`✓ version ${distinct[0]} is consistent across ${sources.length} sources`);
  process.exit(0);
}

console.error("✗ version mismatch — a release built from this tree would ship the wrong version:\n");
for (const s of sources) console.error(`    ${s.version.padEnd(12)} ${s.file}`);
console.error(
  "\n  Set every source to the same version before tagging. A tag that disagrees with\n" +
    "  tauri.conf.json produces a release whose latest.json advertises the OLD version,\n" +
    "  so clients report a successful update and stay on the version they had.",
);
process.exit(1);
