import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { exec } from "./exec.js";

describe("exec", () => {
  let tmpDir: string;
  let callerRepo: string;
  let targetRepo: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dotagents-exec-"));
    callerRepo = join(tmpDir, "caller");
    targetRepo = join(tmpDir, "target");
    await exec("git", ["init", "--quiet", callerRepo]);
    await exec("git", ["init", "--quiet", targetRepo]);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("ignores an inherited GIT_DIR but honours one passed in env", async () => {
    // Git exports GIT_DIR to hooks that run in a linked worktree.
    vi.stubEnv("GIT_DIR", join(callerRepo, ".git"));

    const inherited = await exec("git", ["rev-parse", "--absolute-git-dir"], { cwd: targetRepo });
    const explicit = await exec("git", ["rev-parse", "--absolute-git-dir"], {
      cwd: targetRepo,
      env: { GIT_DIR: join(callerRepo, ".git") },
    });

    expect(await realpath(inherited.stdout.trim())).toBe(await realpath(join(targetRepo, ".git")));
    expect(await realpath(explicit.stdout.trim())).toBe(await realpath(join(callerRepo, ".git")));
  });
});
