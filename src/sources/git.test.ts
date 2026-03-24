import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../utils/exec.js", () => ({
  exec: vi.fn(async () => ({ stdout: "", stderr: "" })),
  ExecError: Error,
}));

import { clone } from "./git.js";
import { exec } from "../utils/exec.js";

const mockExec = vi.mocked(exec);

afterEach(() => vi.clearAllMocks());

describe("clone", () => {
  it("uses --branch for tag refs", async () => {
    await clone("https://github.com/owner/repo.git", "/tmp/dest", "v1.0.0");

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
    await clone("https://github.com/owner/repo.git", "/tmp/dest", "main");

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
    await clone("https://github.com/owner/repo.git", "/tmp/dest", sha);

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
    await clone("https://github.com/owner/repo.git", "/tmp/dest", shortSha);

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
    await clone("https://github.com/owner/repo.git", "/tmp/dest", "abcdef");

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

  it("does not treat refs with non-hex chars as SHAs", async () => {
    // "release-v1" has non-hex chars, even though length > 7
    await clone("https://github.com/owner/repo.git", "/tmp/dest", "release-v1");

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
    await clone("https://github.com/owner/repo.git", "/tmp/dest");

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
