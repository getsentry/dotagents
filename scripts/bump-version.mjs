#!/usr/bin/env node
// Bump both workspace packages to the same version, in lock-step.
//
// Invoked by craft's preReleaseCommand with `$OLD_VERSION $NEW_VERSION`,
// or manually:  node scripts/bump-version.mjs <new-version>
//
// Ensures @sentry/dotagents and @sentry/dotagents-lib never drift.

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

// craft passes [OLD_VERSION, NEW_VERSION]; manual invocation passes just NEW_VERSION.
const args = process.argv.slice(2);
const newVersion = args.length === 2 ? args[1] : args[0];

if (!newVersion) {
  console.error("Usage: bump-version.mjs <new-version>  (or via craft: <old> <new>)");
  process.exit(1);
}

if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(newVersion)) {
  console.error(`bump-version: '${newVersion}' is not a valid semver`);
  process.exit(1);
}

const targets = [
  "package.json",
  "packages/dotagents/package.json",
  "packages/dotagents-lib/package.json",
];

for (const rel of targets) {
  const path = join(repoRoot, rel);
  const pkg = JSON.parse(readFileSync(path, "utf-8"));
  const previous = pkg.version;
  pkg.version = newVersion;
  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log(`bump-version: ${rel}: ${previous} → ${newVersion}`);
}

console.log(`bump-version: all packages now at ${newVersion}`);
