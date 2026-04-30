#!/usr/bin/env node
// Verify the packed tarballs are well-formed before craft publishes them.
//
// Asserts (a) the host's package.json contains NO `workspace:` strings,
// (b) `dependencies["@sentry/dotagents-lib"]` is a concrete semver range
//     that includes the lib's actual version (lock-step check),
// (c) installing the host tarball alongside the lib tarball succeeds and the
//     CLI runs.

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cwd = process.cwd();
const tarballs = readdirSync(cwd).filter((f) => f.endsWith(".tgz"));
if (tarballs.length === 0) {
  console.error("verify-pack: no *.tgz files found in", cwd);
  process.exit(1);
}

const host = tarballs.find((f) => /^sentry-dotagents-\d/.test(f));
const lib = tarballs.find((f) => /^sentry-dotagents-lib-\d/.test(f));

if (!host || !lib) {
  console.error("verify-pack: expected one host tarball and one lib tarball, found:", tarballs);
  process.exit(1);
}

console.log(`verify-pack: host=${host}, lib=${lib}`);

const inspectDir = mkdtempSync(join(tmpdir(), "dotagents-inspect-"));
try {
  // Extract just the package.json files for inspection.
  execFileSync("tar", ["-xzf", join(cwd, host), "-C", inspectDir, "package/package.json"], { stdio: "inherit" });
  const hostPkg = JSON.parse(readFileSync(join(inspectDir, "package", "package.json"), "utf-8"));

  rmSync(join(inspectDir, "package"), { recursive: true, force: true });
  execFileSync("tar", ["-xzf", join(cwd, lib), "-C", inspectDir, "package/package.json"], { stdio: "inherit" });
  const libPkg = JSON.parse(readFileSync(join(inspectDir, "package", "package.json"), "utf-8"));

  // (a) No `workspace:` strings in the host's published package.json.
  const hostJson = JSON.stringify(hostPkg);
  if (hostJson.includes("workspace:")) {
    console.error("verify-pack: host package.json still contains 'workspace:' references");
    console.error(hostJson);
    process.exit(1);
  }

  // (b) Host's lib dep is a published range that matches the lib's version.
  const libDep = hostPkg.dependencies?.["@sentry/dotagents-lib"];
  if (!libDep) {
    console.error("verify-pack: host is missing dependency on @sentry/dotagents-lib");
    process.exit(1);
  }
  if (libDep.startsWith("workspace:") || libDep.includes("link:")) {
    console.error("verify-pack: host's lib dep is not a published range:", libDep);
    process.exit(1);
  }
  if (!libDep.includes(libPkg.version)) {
    console.error(
      `verify-pack: host depends on lib '${libDep}' but lib is version '${libPkg.version}' — versions out of lock-step`,
    );
    process.exit(1);
  }

  console.log(`verify-pack: package.json invariants OK (host depends on lib '${libDep}', lib is '${libPkg.version}')`);
} finally {
  rmSync(inspectDir, { recursive: true, force: true });
}

// (c) Real install + CLI smoke from the tarballs.
const installDir = mkdtempSync(join(tmpdir(), "dotagents-install-"));
try {
  // Use a separate npm registry-like layout: install both tarballs as local files.
  writeFileSync(
    join(installDir, "package.json"),
    JSON.stringify({ name: "verify-pack-tmp", version: "0.0.0", private: true }, null, 2),
  );
  execFileSync(
    "npm",
    ["install", "--no-audit", "--no-fund", "--no-package-lock", join(cwd, lib), join(cwd, host)],
    { cwd: installDir, stdio: "inherit" },
  );

  execFileSync("node", ["node_modules/@sentry/dotagents/dist/cli/index.js", "--help"], {
    cwd: installDir,
    stdio: "inherit",
  });

  console.log("verify-pack: install + CLI smoke OK");
} finally {
  rmSync(installDir, { recursive: true, force: true });
}
