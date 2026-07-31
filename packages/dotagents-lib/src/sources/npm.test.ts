import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseNpmSpecifier, resolveNpmSource, NpmSourceError } from "./npm.js";
import {
  parseSource,
  isExplicitSourceSpecifier,
  resolveSkill,
  resolveWildcardSkills,
} from "../skills/resolver.js";
import { validateTrustedSource } from "../trust/validator.js";
import type { TrustPolicy } from "../trust/policy.js";

async function writeSkill(dir: string, name: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} test skill\n---\n\n# ${name}\n`,
  );
}

describe("parseNpmSpecifier", () => {
  it("parses a scoped package with subpath", () => {
    expect(parseNpmSpecifier("@acme/ui-kit/skills/upgrade")).toEqual({
      packageName: "@acme/ui-kit",
      subpath: "skills/upgrade",
    });
  });

  it("parses an unscoped package without subpath", () => {
    expect(parseNpmSpecifier("ui-kit")).toEqual({ packageName: "ui-kit" });
  });

  it("rejects a bare scope", () => {
    expect(() => parseNpmSpecifier("@acme")).toThrow(NpmSourceError);
  });

  it("rejects invalid package names", () => {
    expect(() => parseNpmSpecifier("UpperCase/skills")).toThrow(NpmSourceError);
    expect(() => parseNpmSpecifier("")).toThrow(NpmSourceError);
    expect(() => parseNpmSpecifier("../escape")).toThrow(NpmSourceError);
  });
});

describe("parseSource npm:", () => {
  it("classifies npm: as its own source type", () => {
    expect(parseSource("npm:@acme/ui-kit/skills/upgrade")).toEqual({
      type: "npm",
      path: "@acme/ui-kit/skills/upgrade",
    });
  });

  it("treats npm: as an explicit specifier (never owner/repo shorthand)", () => {
    expect(isExplicitSourceSpecifier("npm:@acme/ui-kit")).toBe(true);
  });
});

describe("trust", () => {
  it("always allows npm: sources, like local paths", () => {
    const restrictive: TrustPolicy = {
      allow_all: false,
      github_orgs: [],
      github_repos: [],
      git_domains: [],
    };
    expect(() =>
      validateTrustedSource("npm:@acme/ui-kit/skills/upgrade", restrictive),
    ).not.toThrow();
  });
});

describe("resolveNpmSource", () => {
  let tmpDir: string;
  let projectRoot: string;
  let stateDir: string;

  beforeEach(async () => {
    // realpath so expectations match require.resolve, which returns canonical
    // paths (macOS tmpdir lives behind a /var → /private/var symlink).
    tmpDir = await realpath(await mkdtemp(join(tmpdir(), "dotagents-npm-")));
    projectRoot = join(tmpDir, "project");
    stateDir = join(tmpDir, "state");
    await mkdir(projectRoot, { recursive: true });
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(projectRoot, "package.json"), JSON.stringify({ name: "consumer" }));

    // Scoped package whose exports map does NOT expose ./package.json —
    // exercises the node_modules walk fallback.
    const scoped = join(projectRoot, "node_modules", "@acme", "ui-kit");
    await mkdir(scoped, { recursive: true });
    await writeFile(
      join(scoped, "package.json"),
      JSON.stringify({ name: "@acme/ui-kit", version: "70.0.0", exports: { ".": "./index.js" } }),
    );
    await writeSkill(join(scoped, "skills", "ui-kit-upgrade"), "ui-kit-upgrade");
    await writeSkill(join(scoped, "skills", "input-migration"), "input-migration");

    // Unscoped package without an exports map — resolves via require.resolve.
    const plain = join(projectRoot, "node_modules", "plainlib");
    await mkdir(plain, { recursive: true });
    await writeFile(
      join(plain, "package.json"),
      JSON.stringify({ name: "plainlib", version: "1.0.0", main: "index.js" }),
    );
    await writeFile(join(plain, "index.js"), "module.exports = {};\n");
    await writeSkill(join(plain, "skill"), "plain-skill");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("resolves a subdirectory of an installed scoped package", async () => {
    const dir = await resolveNpmSource(projectRoot, "@acme/ui-kit/skills/ui-kit-upgrade");
    expect(dir).toBe(
      join(projectRoot, "node_modules", "@acme", "ui-kit", "skills", "ui-kit-upgrade"),
    );
  });

  it("resolves an unscoped package via require.resolve", async () => {
    const dir = await resolveNpmSource(projectRoot, "plainlib/skill");
    expect(dir).toBe(join(projectRoot, "node_modules", "plainlib", "skill"));
  });

  it("rejects packages that are not installed", async () => {
    await expect(resolveNpmSource(projectRoot, "@acme/missing")).rejects.toThrow(
      /not installed/,
    );
  });

  it("rejects subpaths that escape the package", async () => {
    await expect(
      resolveNpmSource(projectRoot, "@acme/ui-kit/skills/../../ui-kit-sibling"),
    ).rejects.toThrow(NpmSourceError);
  });

  it("rejects subpaths that do not exist", async () => {
    await expect(
      resolveNpmSource(projectRoot, "@acme/ui-kit/skills/nope"),
    ).rejects.toThrow(/not found/);
  });

  it("resolves a named skill end-to-end through resolveSkill", async () => {
    const resolved = await resolveSkill(
      "ui-kit-upgrade",
      { source: "npm:@acme/ui-kit/skills/ui-kit-upgrade" },
      { stateDir, projectRoot },
    );
    expect(resolved.type).toBe("local");
    expect(resolved.skillDir).toBe(
      join(projectRoot, "node_modules", "@acme", "ui-kit", "skills", "ui-kit-upgrade"),
    );
  });

  it("resolves wildcard skills scoped by path", async () => {
    const resolved = await resolveWildcardSkills(
      { source: "npm:@acme/ui-kit", path: "skills" },
      { stateDir, projectRoot },
    );
    expect(resolved.map((r) => r.name).toSorted()).toEqual([
      "input-migration",
      "ui-kit-upgrade",
    ]);
    for (const skill of resolved) {
      expect(skill.resolved.type).toBe("local");
    }
  });
});
