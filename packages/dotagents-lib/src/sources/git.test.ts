import { describe, it, expect, vi, afterEach } from "vitest";
import { clone, fetchAndReset, fetchRef, headCommitDate, findCommitOlderThan, type GitExecutor } from "./git.js";
import { ExecError } from "../utils/exec.js";

const mockExec = vi.fn<GitExecutor>(async () => ({ stdout: "", stderr: "" }));

afterEach(() => vi.clearAllMocks());

describe("clone", () => {
  it("uses --branch for tag refs", async () => {
    await clone("https://github.com/owner/repo.git", "/tmp/dest", "v1.0.0", mockExec);

    expect(mockExec).toHaveBeenCalledTimes(1);
    expect(mockExec).toHaveBeenCalledWith("git", [
      "clone",
      "--depth=1",
      "--branch",
      "v1.0.0",
      "--",
      "https://github.com/owner/repo.git",
      "/tmp/dest",
    ]);
  });

  it("uses --branch for branch refs", async () => {
    await clone("https://github.com/owner/repo.git", "/tmp/dest", "main", mockExec);

    expect(mockExec).toHaveBeenCalledTimes(1);
    expect(mockExec).toHaveBeenCalledWith("git", [
      "clone",
      "--depth=1",
      "--branch",
      "main",
      "--",
      "https://github.com/owner/repo.git",
      "/tmp/dest",
    ]);
  });

  it("skips --branch for full SHA refs and fetches after clone", async () => {
    const sha = "405638a2ee3f131b910be238af499eac5c86e92c";
    await clone("https://github.com/owner/repo.git", "/tmp/dest", sha, mockExec);

    expect(mockExec).toHaveBeenCalledTimes(3);
    // First call: clone without --branch
    expect(mockExec).toHaveBeenNthCalledWith(1, "git", [
      "clone",
      "--depth=1",
      "--",
      "https://github.com/owner/repo.git",
      "/tmp/dest",
    ]);
    // Second call: fetch the specific SHA
    expect(mockExec).toHaveBeenNthCalledWith(2, "git", [
      "fetch",
      "--force",
      "--depth=1",
      "--",
      "origin",
      sha,
    ], { cwd: "/tmp/dest" });
    // Third call: checkout FETCH_HEAD
    expect(mockExec).toHaveBeenNthCalledWith(3, "git", [
      "checkout",
      "FETCH_HEAD",
    ], { cwd: "/tmp/dest" });
  });

  it("skips --branch for short SHA refs (7+ hex chars)", async () => {
    const shortSha = "405638a";
    await clone("https://github.com/owner/repo.git", "/tmp/dest", shortSha, mockExec);

    // Clone without --branch, then fetch+checkout
    expect(mockExec).toHaveBeenCalledTimes(3);
    expect(mockExec).toHaveBeenNthCalledWith(1, "git", [
      "clone",
      "--depth=1",
      "--",
      "https://github.com/owner/repo.git",
      "/tmp/dest",
    ]);
  });

  it("does not treat 6-char hex strings as SHAs", async () => {
    await clone("https://github.com/owner/repo.git", "/tmp/dest", "abcdef", mockExec);

    // Too short — treated as a branch name
    expect(mockExec).toHaveBeenCalledTimes(1);
    expect(mockExec).toHaveBeenCalledWith("git", [
      "clone",
      "--depth=1",
      "--branch",
      "abcdef",
      "--",
      "https://github.com/owner/repo.git",
      "/tmp/dest",
    ]);
  });

  it("handles uppercase SHA refs", async () => {
    const sha = "405638A2EE3F131B910BE238AF499EAC5C86E92C";
    await clone("https://github.com/owner/repo.git", "/tmp/dest", sha, mockExec);

    expect(mockExec).toHaveBeenCalledTimes(3);
    expect(mockExec).toHaveBeenNthCalledWith(1, "git", [
      "clone",
      "--depth=1",
      "--",
      "https://github.com/owner/repo.git",
      "/tmp/dest",
    ]);
  });

  it("does not treat refs with non-hex chars as SHAs", async () => {
    // "release-v1" has non-hex chars, even though length > 7
    await clone("https://github.com/owner/repo.git", "/tmp/dest", "release-v1", mockExec);

    expect(mockExec).toHaveBeenCalledTimes(1);
    expect(mockExec).toHaveBeenCalledWith("git", [
      "clone",
      "--depth=1",
      "--branch",
      "release-v1",
      "--",
      "https://github.com/owner/repo.git",
      "/tmp/dest",
    ]);
  });

  it("clones without ref when none provided", async () => {
    await clone("https://github.com/owner/repo.git", "/tmp/dest", undefined, mockExec);

    expect(mockExec).toHaveBeenCalledTimes(1);
    expect(mockExec).toHaveBeenCalledWith("git", [
      "clone",
      "--depth=1",
      "--",
      "https://github.com/owner/repo.git",
      "/tmp/dest",
    ]);
  });
});

describe("fetchAndReset", () => {
  it("force-fetches origin before resetting to FETCH_HEAD", async () => {
    await fetchAndReset("/tmp/repo", mockExec);

    expect(mockExec).toHaveBeenNthCalledWith(1, "git", [
      "fetch",
      "--force",
      "--depth=1",
      "--",
      "origin",
    ], { cwd: "/tmp/repo" });
    expect(mockExec).toHaveBeenNthCalledWith(2, "git", [
      "reset",
      "--hard",
      "FETCH_HEAD",
    ], { cwd: "/tmp/repo" });
  });
});

describe("fetchRef", () => {
  it("force-fetches the requested ref before checkout", async () => {
    await fetchRef("/tmp/repo", "v0", mockExec);

    expect(mockExec).toHaveBeenNthCalledWith(1, "git", [
      "fetch",
      "--force",
      "--depth=1",
      "--",
      "origin",
      "v0",
    ], { cwd: "/tmp/repo" });
    expect(mockExec).toHaveBeenNthCalledWith(2, "git", [
      "checkout",
      "FETCH_HEAD",
    ], { cwd: "/tmp/repo" });
  });
});

describe("headCommitDate", () => {
  it("returns the committer date of HEAD", async () => {
    mockExec.mockResolvedValueOnce({ stdout: "2026-03-15T10:30:00+00:00\n", stderr: "" });

    const date = await headCommitDate("/tmp/repo", mockExec);

    expect(mockExec).toHaveBeenCalledWith(
      "git",
      ["log", "-1", "--format=%cI", "HEAD"],
      { cwd: "/tmp/repo" },
    );
    expect(date.toISOString()).toBe("2026-03-15T10:30:00.000Z");
  });
});

describe("findCommitOlderThan", () => {
  it("returns SHA when a qualifying commit exists", async () => {
    const sha = "abc123def456789012345678901234567890abcd";
    // First call: fetch --unshallow
    mockExec.mockResolvedValueOnce({ stdout: "", stderr: "" });
    // Second call: git log --before
    mockExec.mockResolvedValueOnce({ stdout: `${sha}\n`, stderr: "" });

    const result = await findCommitOlderThan("/tmp/repo", 3, mockExec);

    expect(result).toBe(sha);
    expect(mockExec).toHaveBeenNthCalledWith(
      1,
      "git",
      ["fetch", "--force", "--unshallow", "--", "origin"],
      { cwd: "/tmp/repo" },
    );
    expect(mockExec).toHaveBeenNthCalledWith(
      2,
      "git",
      expect.arrayContaining(["log", "--format=%H", "--before", expect.any(String), "-1", "HEAD"]),
      { cwd: "/tmp/repo" },
    );
  });

  it("returns null when no qualifying commit exists", async () => {
    // fetch --unshallow succeeds
    mockExec.mockResolvedValueOnce({ stdout: "", stderr: "" });
    // git log returns empty (repo younger than threshold)
    mockExec.mockResolvedValueOnce({ stdout: "", stderr: "" });

    const result = await findCommitOlderThan("/tmp/repo", 30, mockExec);

    expect(result).toBeNull();
  });

  it("tolerates already-unshallowed repos", async () => {
    const sha = "abc123def456789012345678901234567890abcd";
    // fetch --unshallow fails because repo is already complete
    const stderr = "fatal: --unshallow on a complete repository does not make sense";
    const err = new ExecError(stderr, 128, stderr);
    mockExec.mockRejectedValueOnce(err);
    // git log --before
    mockExec.mockResolvedValueOnce({ stdout: `${sha}\n`, stderr: "" });

    const result = await findCommitOlderThan("/tmp/repo", 3, mockExec);

    expect(result).toBe(sha);
  });
});
