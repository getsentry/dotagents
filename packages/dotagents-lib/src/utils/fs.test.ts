import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import {
  copyDir,
  isAbsolutePathString,
  isInsideDir,
  isWindowsDrivePath,
} from "./fs.js";

describe("isWindowsDrivePath / isAbsolutePathString", () => {
  it.each(["C:\\repo", "C:/repo", "z:\\repo"])(
    "treats %s as a drive root",
    (s) => {
      expect(isWindowsDrivePath(s)).toBe(true);
      expect(isAbsolutePathString(s)).toBe(true);
    },
  );

  it.each([
    // Drive-*relative*: no separator after the colon, so not a root. This
    // boundary is load-bearing — the config schema rejects it, and the cache
    // must not mistake it for a drive it can strip.
    "C:repo",
    "repo",
    "./repo",
    "github.com/owner/repo",
    "https://example.com/repo.git",
  ])("does not treat %s as a drive root", (s) => {
    expect(isWindowsDrivePath(s)).toBe(false);
  });

  it("counts a POSIX absolute path as absolute but not as a drive path", () => {
    expect(isWindowsDrivePath("/repo")).toBe(false);
    expect(isAbsolutePathString("/repo")).toBe(true);
  });

  it("does not count relative paths as absolute", () => {
    expect(isAbsolutePathString("repo/skills")).toBe(false);
    expect(isAbsolutePathString("C:repo")).toBe(false);
  });
});

describe("isInsideDir", () => {
  const root = resolve("/project");

  it("accepts the root itself and paths beneath it", () => {
    expect(isInsideDir(root, root)).toBe(true);
    expect(isInsideDir(root, join(root, "skills"))).toBe(true);
    expect(isInsideDir(root, join(root, "skills", "review"))).toBe(true);
  });

  it("rejects the parent, siblings, and paths that escape", () => {
    expect(isInsideDir(root, resolve(root, ".."))).toBe(false);
    expect(isInsideDir(root, resolve(root, "../sibling"))).toBe(false);
    expect(isInsideDir(root, resolve(root, "skills/../../escape"))).toBe(false);
  });

  it("accepts a child whose name merely starts with ..", () => {
    // A bare `rel.startsWith("..")` check misreads this as a traversal; the
    // whole-segment comparison is what keeps it a legitimate child.
    expect(isInsideDir(root, join(root, "..foo"))).toBe(true);
  });
});

describe("copyDir", () => {
  let srcDir: string;
  let destDir: string;

  beforeEach(async () => {
    srcDir = await mkdtemp(join(tmpdir(), "dotagents-copydir-src-"));
    destDir = join(await mkdtemp(join(tmpdir(), "dotagents-copydir-")), "dest");
  });

  afterEach(async () => {
    await rm(srcDir, { recursive: true });
    await rm(destDir, { recursive: true, force: true });
  });

  it("excludes .git but copies other dotfiles", async () => {
    await mkdir(join(srcDir, ".git", "objects"), { recursive: true });
    await writeFile(join(srcDir, ".git", "HEAD"), "ref: refs/heads/main");
    await writeFile(join(srcDir, "SKILL.md"), "# skill");
    await mkdir(join(srcDir, ".github"), { recursive: true });
    await writeFile(join(srcDir, ".github", "README.md"), "# readme");

    await copyDir(srcDir, destDir);

    expect(existsSync(join(destDir, "SKILL.md"))).toBe(true);
    expect(existsSync(join(destDir, ".github", "README.md"))).toBe(true);
    expect(existsSync(join(destDir, ".git"))).toBe(false);
  });
});
