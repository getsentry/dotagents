import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, mkdir, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { findGitDir, bootstrapPostMergeHook } from "./git-hooks.js";

describe("findGitDir", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "dotagents-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true });
  });

  it("returns .git path when it is a directory", async () => {
    await mkdir(join(dir, ".git"));

    const result = findGitDir(dir);
    expect(result).toBe(join(dir, ".git"));
  });

  it("returns null when .git does not exist", () => {
    const result = findGitDir(dir);
    expect(result).toBeNull();
  });

  it("follows gitdir pointer in worktrees", async () => {
    const worktreeGitDir = join(dir, "real-git-dir");
    await mkdir(worktreeGitDir, { recursive: true });
    await writeFile(join(dir, ".git"), `gitdir: ${worktreeGitDir}\n`, "utf-8");

    const result = findGitDir(dir);
    expect(result).toBe(worktreeGitDir);
  });
});

describe("bootstrapPostMergeHook", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "dotagents-test-"));
    await mkdir(join(dir, ".git"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true });
  });

  it("creates hook when none exists", async () => {
    const created = await bootstrapPostMergeHook(dir);

    expect(created).toBe(true);
    const hookPath = join(dir, ".git", "hooks", "post-merge");
    expect(existsSync(hookPath)).toBe(true);
    const content = await readFile(hookPath, "utf-8");
    expect(content).toContain("dotagents install");
    expect(content.startsWith("#!/bin/sh")).toBe(true);
  });

  it("skips when hook already has dotagents", async () => {
    await mkdir(join(dir, ".git", "hooks"));
    await writeFile(
      join(dir, ".git", "hooks", "post-merge"),
      "#!/bin/sh\nnpx @sentry/dotagents install\n",
    );

    const created = await bootstrapPostMergeHook(dir);
    expect(created).toBe(false);
  });

  it("sets executable permission", async () => {
    await bootstrapPostMergeHook(dir);

    const hookPath = join(dir, ".git", "hooks", "post-merge");
    const s = await stat(hookPath);
    // Check owner execute bit
    expect(s.mode & 0o100).toBeTruthy();
  });

  it("creates hooks directory if missing", async () => {
    expect(existsSync(join(dir, ".git", "hooks"))).toBe(false);

    await bootstrapPostMergeHook(dir);

    expect(existsSync(join(dir, ".git", "hooks"))).toBe(true);
    expect(existsSync(join(dir, ".git", "hooks", "post-merge"))).toBe(true);
  });

  it("returns false when no .git directory", async () => {
    const noGitDir = await mkdtemp(join(tmpdir(), "dotagents-test-"));
    try {
      const created = await bootstrapPostMergeHook(noGitDir);
      expect(created).toBe(false);
    } finally {
      await rm(noGitDir, { recursive: true });
    }
  });
});
