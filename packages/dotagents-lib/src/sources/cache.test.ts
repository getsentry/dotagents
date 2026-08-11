import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureCached, validateCacheKey, CacheError } from "./cache.js";
import { exec } from "../utils/exec.js";

async function configureTestGitRepo(repoDir: string): Promise<void> {
  await exec("git", ["config", "user.email", "test@test.com"], { cwd: repoDir });
  await exec("git", ["config", "user.name", "Test"], { cwd: repoDir });
  await exec("git", ["config", "commit.gpgsign", "false"], { cwd: repoDir });
}

describe("validateCacheKey", () => {
  it.each([
    ["empty string", ""],
    ["absolute unix path", "/etc/passwd"],
    ["absolute windows path", "C:\\Windows\\System32"],
    ["parent traversal", "owner/../../etc"],
    ["leading parent", "../escape"],
    ["bare parent", ".."],
    ["bare current", "."],
    ["embedded dot segment", "owner/./repo"],
    ["backslash", "owner\\repo"],
    ["double slash", "owner//repo"],
  ])("rejects %s", (_label, key) => {
    expect(() => validateCacheKey(key)).toThrow(CacheError);
  });

  it.each([
    "owner/repo",
    "owner-with-dash/repo.with.dots",
    "git.corp.example.com/team/skills",
    "wellknown/cli.sentry.dev/path",
  ])("accepts %s", (key) => {
    expect(() => validateCacheKey(key)).not.toThrow();
  });
});

describe("ensureCached", () => {
  let tmpDir: string;
  let stateDir: string;
  let remoteDir: string;
  let repoDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dotagents-cache-"));
    stateDir = join(tmpDir, "state");
    remoteDir = join(tmpDir, "remote.git");
    repoDir = join(tmpDir, "repo");

    await exec("git", ["init", "--bare", "--initial-branch=main", remoteDir]);
    await exec("git", ["clone", remoteDir, repoDir]);
    await configureTestGitRepo(repoDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("picks up upstream changes on repeated calls", async () => {
    await writeFile(join(repoDir, "README.md"), "first\n");
    await exec("git", ["add", "README.md"], { cwd: repoDir });
    await exec("git", ["commit", "-m", "initial"], { cwd: repoDir });
    await exec("git", ["push", "origin", "main"], { cwd: repoDir });

    const first = await ensureCached({
      stateDir,
      url: remoteDir,
      cacheKey: "test/repo",
    });

    // Push a new commit upstream
    await writeFile(join(repoDir, "README.md"), "second\n");
    await exec("git", ["add", "README.md"], { cwd: repoDir });
    await exec("git", ["commit", "-m", "second"], { cwd: repoDir });
    await exec("git", ["push", "origin", "main"], { cwd: repoDir });
    const { stdout } = await exec("git", ["rev-parse", "HEAD"], { cwd: repoDir });
    const latestCommit = stdout.trim();

    const second = await ensureCached({
      stateDir,
      url: remoteDir,
      cacheKey: "test/repo",
    });

    expect(second.commit).toBe(latestCommit);
    expect(second.commit).not.toBe(first.commit);
  });

  it("can reuse an existing checkout without refreshing it", async () => {
    await writeFile(join(repoDir, "README.md"), "first\n");
    await exec("git", ["add", "README.md"], { cwd: repoDir });
    await exec("git", ["commit", "-m", "initial"], { cwd: repoDir });
    await exec("git", ["push", "origin", "main"], { cwd: repoDir });

    const first = await ensureCached({
      stateDir,
      url: remoteDir,
      cacheKey: "test/repo",
    });

    await writeFile(join(repoDir, "README.md"), "second\n");
    await exec("git", ["add", "README.md"], { cwd: repoDir });
    await exec("git", ["commit", "-m", "second"], { cwd: repoDir });
    await exec("git", ["push", "origin", "main"], { cwd: repoDir });

    const reused = await ensureCached({
      stateDir,
      url: remoteDir,
      cacheKey: "test/repo",
      refresh: false,
    });
    const refreshed = await ensureCached({
      stateDir,
      url: remoteDir,
      cacheKey: "test/repo",
    });

    expect(reused.commit).toBe(first.commit);
    expect(refreshed.commit).not.toBe(first.commit);
  });

  it("serializes concurrent first-time clones for the same cache key", async () => {
    await writeFile(join(repoDir, "README.md"), "first\n");
    await exec("git", ["add", "README.md"], { cwd: repoDir });
    await exec("git", ["commit", "-m", "initial"], { cwd: repoDir });
    await exec("git", ["push", "origin", "main"], { cwd: repoDir });
    const { stdout } = await exec("git", ["rev-parse", "HEAD"], { cwd: repoDir });
    const latestCommit = stdout.trim();

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        ensureCached({
          stateDir,
          url: remoteDir,
          cacheKey: "test/repo",
        }),
      ),
    );

    expect(results.map((result) => result.commit)).toEqual(
      Array.from({ length: 5 }, () => latestCommit),
    );
  });

  it("replaces stale non-git cache directories before cloning", async () => {
    await writeFile(join(repoDir, "README.md"), "first\n");
    await exec("git", ["add", "README.md"], { cwd: repoDir });
    await exec("git", ["commit", "-m", "initial"], { cwd: repoDir });
    await exec("git", ["push", "origin", "main"], { cwd: repoDir });
    const { stdout } = await exec("git", ["rev-parse", "HEAD"], { cwd: repoDir });
    const latestCommit = stdout.trim();

    const staleDir = join(stateDir, "test", "repo");
    await mkdir(staleDir, { recursive: true });
    await writeFile(join(staleDir, "partial-clone"), "stale\n");

    const result = await ensureCached({
      stateDir,
      url: remoteDir,
      cacheKey: "test/repo",
    });

    expect(result.commit).toBe(latestCommit);
  });

  it("refreshes an unpinned cache after a pinned ref fetch", async () => {
    await writeFile(join(repoDir, "README.md"), "first\n");
    await exec("git", ["add", "README.md"], { cwd: repoDir });
    await exec("git", ["commit", "-m", "initial"], { cwd: repoDir });
    const { stdout: initialStdout } = await exec("git", ["rev-parse", "HEAD"], { cwd: repoDir });
    const initialCommit = initialStdout.trim();
    await exec("git", ["branch", "stable", initialCommit], { cwd: repoDir });
    await exec("git", ["push", "origin", "main", "stable"], { cwd: repoDir });

    const first = await ensureCached({
      stateDir,
      url: remoteDir,
      cacheKey: "test/repo",
    });

    await writeFile(join(repoDir, "README.md"), "second\n");
    await exec("git", ["add", "README.md"], { cwd: repoDir });
    await exec("git", ["commit", "-m", "second"], { cwd: repoDir });
    await exec("git", ["push", "origin", "main", "stable"], { cwd: repoDir });
    const { stdout: latestStdout } = await exec("git", ["rev-parse", "HEAD"], { cwd: repoDir });
    const latestCommit = latestStdout.trim();

    const pinned = await ensureCached({
      stateDir,
      url: remoteDir,
      cacheKey: "test/repo",
      ref: "stable",
    });
    expect(pinned.commit).toBe(initialCommit);

    const unpinned = await ensureCached({
      stateDir,
      url: remoteDir,
      cacheKey: "test/repo",
    });

    expect(first.commit).toBe(initialCommit);
    expect(unpinned.commit).toBe(latestCommit);
  });

  it("refreshes an unpinned cache after minimum_release_age checked out an older commit", async () => {
    await writeFile(join(repoDir, "README.md"), "old\n");
    await exec("git", ["add", "README.md"], { cwd: repoDir });
    await exec("git", ["commit", "-m", "old commit", "--date", "2020-01-01T00:00:00"], {
      cwd: repoDir,
      env: { ...process.env, GIT_COMMITTER_DATE: "2020-01-01T00:00:00" },
    });
    const { stdout: oldStdout } = await exec("git", ["rev-parse", "HEAD"], { cwd: repoDir });
    const oldCommit = oldStdout.trim();
    await exec("git", ["push", "origin", "main"], { cwd: repoDir });

    await writeFile(join(repoDir, "README.md"), "new\n");
    await exec("git", ["add", "README.md"], { cwd: repoDir });
    await exec("git", ["commit", "-m", "new commit"], { cwd: repoDir });
    await exec("git", ["push", "origin", "main"], { cwd: repoDir });
    const { stdout: latestStdout } = await exec("git", ["rev-parse", "HEAD"], { cwd: repoDir });
    const latestCommit = latestStdout.trim();

    const ageGated = await ensureCached({
      stateDir,
      url: remoteDir,
      cacheKey: "test/repo",
      minimumReleaseAge: 1,
    });
    expect(ageGated.commit).toBe(oldCommit);

    const unpinned = await ensureCached({
      stateDir,
      url: remoteDir,
      cacheKey: "test/repo",
    });
    expect(unpinned.commit).toBe(latestCommit);
  });
});
