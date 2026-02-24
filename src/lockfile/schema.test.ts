import { describe, it, expect } from "vitest";
import { lockfileSchema, isGitLocked } from "./schema.js";

describe("lockfileSchema", () => {
  it("parses a minimal lockfile", () => {
    const result = lockfileSchema.safeParse({ version: 1 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.skills).toEqual({});
    }
  });

  it("parses a lockfile with git skills", () => {
    const result = lockfileSchema.safeParse({
      version: 1,
      skills: {
        "pdf-processing": {
          source: "anthropics/skills",
          resolved_url: "https://github.com/anthropics/skills.git",
          resolved_path: "pdf-processing",
          resolved_ref: "v1.2.0",
          commit: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
          integrity: "sha256-Kx3bXjQ9mFpLw7rN8vYzTg==",
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("parses a lockfile with local skills", () => {
    const result = lockfileSchema.safeParse({
      version: 1,
      skills: {
        "my-skill": {
          source: "path:../shared/my-skill",
          integrity: "sha256-Kx3bXjQ9mFpLw7rN8vYzTg==",
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid version", () => {
    expect(lockfileSchema.safeParse({ version: 2 }).success).toBe(false);
  });

  it("parses unpinned git skills (no commit/integrity)", () => {
    const result = lockfileSchema.safeParse({
      version: 1,
      skills: {
        "my-skill": {
          source: "org/repo",
          resolved_url: "https://github.com/org/repo.git",
          resolved_path: "my-skill",
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("parses unpinned local skills (no integrity)", () => {
    const result = lockfileSchema.safeParse({
      version: 1,
      skills: {
        local: {
          source: "path:../local",
        },
      },
    });
    expect(result.success).toBe(true);
  });
});

describe("isGitLocked", () => {
  it("returns true for git-locked skills", () => {
    expect(
      isGitLocked({
        source: "anthropics/skills",
        resolved_url: "https://github.com/anthropics/skills.git",
        resolved_path: "pdf-processing",
        commit: "abc123",
        integrity: "sha256-test",
      }),
    ).toBe(true);
  });

  it("returns true for unpinned git-locked skills (no commit)", () => {
    expect(
      isGitLocked({
        source: "org/repo",
        resolved_url: "https://github.com/org/repo.git",
        resolved_path: "my-skill",
      }),
    ).toBe(true);
  });

  it("returns false for local-locked skills", () => {
    expect(
      isGitLocked({
        source: "path:../shared/my-skill",
        integrity: "sha256-test",
      }),
    ).toBe(false);
  });

  it("returns false for unpinned local-locked skills", () => {
    expect(
      isGitLocked({
        source: "path:../shared/my-skill",
      }),
    ).toBe(false);
  });
});
