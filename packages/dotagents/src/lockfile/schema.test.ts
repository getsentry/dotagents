import { describe, it, expect } from "vitest";
import { lockfileSchema } from "./schema.js";

describe("lockfileSchema", () => {
  it("rejects invalid version", () => {
    expect(lockfileSchema.safeParse({ version: 2 }).success).toBe(false);
  });

  it("treats resolved_commit as optional (backwards compat)", () => {
    const result = lockfileSchema.safeParse({
      version: 1,
      skills: {
        "my-skill": {
          source: "org/repo",
          resolved_url: "https://github.com/org/repo.git",
          resolved_path: "my-skill",
          resolved_ref: "v1.0.0",
        },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const skill = result.data.skills["my-skill"]!;
      expect("resolved_commit" in skill).toBe(false);
    }
  });

  it("allows resolved paths for wildcard-expanded local skills", () => {
    const result = lockfileSchema.safeParse({
      version: 1,
      skills: {
        review: {
          source: "path:local-skills",
          resolved_path: "engineering/review",
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it("rejects empty resolved paths", () => {
    const result = lockfileSchema.safeParse({
      version: 1,
      skills: { review: { source: "path:local-skills", resolved_path: "" } },
    });

    expect(result.success).toBe(false);
  });

  it("does not reclassify malformed lock entries", () => {
    const gitWithEmptyPath = lockfileSchema.safeParse({
      version: 1,
      skills: {
        review: {
          source: "org/repo",
          resolved_url: "https://github.com/org/repo.git",
          resolved_path: "",
        },
      },
    });
    const wellKnownWithPath = lockfileSchema.safeParse({
      version: 1,
      skills: {
        review: {
          source: "https://skills.example.com",
          resolved_url: "https://skills.example.com",
          resolved_path: "review",
        },
      },
    });
    const localWithGitMetadata = lockfileSchema.safeParse({
      version: 1,
      skills: {
        review: {
          source: "path:local-skills",
          resolved_url: "https://github.com/org/repo.git",
          resolved_path: "review",
        },
      },
    });

    expect(gitWithEmptyPath.success).toBe(false);
    expect(wellKnownWithPath.success).toBe(false);
    expect(localWithGitMetadata.success).toBe(false);
  });

  it("retains legacy Git lock entries with malformed source strings", () => {
    const result = lockfileSchema.safeParse({
      version: 1,
      skills: {
        review: {
          source: "org/repo@",
          resolved_url: "https://github.com/org/repo.git",
          resolved_path: "review",
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it("retains legacy well-known lock entries with malformed source strings", () => {
    const result = lockfileSchema.safeParse({
      version: 1,
      skills: {
        review: {
          source: "org/repo@",
          resolved_url: "https://skills.example.com",
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it.each([
    "/absolute/review",
    "C:\\absolute\\review",
    "C:relative\\review",
    "../outside/review",
    "scope/../outside/review",
  ])("rejects non-canonical resolved path %s", (resolvedPath) => {
    const result = lockfileSchema.safeParse({
      version: 1,
      skills: {
        review: {
          source: "org/repo",
          resolved_url: "https://github.com/org/repo.git",
          resolved_path: resolvedPath,
        },
      },
    });

    expect(result.success).toBe(false);
  });

  it("rejects well-known-style subagent lock entries", () => {
    const result = lockfileSchema.safeParse({
      version: 1,
      skills: {},
      subagents: {
        reviewer: {
          source: "https://example.com",
          resolved_url: "https://example.com",
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it("accepts plugin lock entries", () => {
    const result = lockfileSchema.safeParse({
      version: 1,
      skills: {},
      subagents: {},
      plugins: {
        "review-tools": {
          source: "getsentry/plugins",
          resolved_url: "https://github.com/getsentry/plugins.git",
          resolved_path: "review-tools",
          resolved_ref: "v1.0.0",
          resolved_commit: "abc123",
        },
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.plugins["review-tools"]!.source).toBe("getsentry/plugins");
    }
  });
});
