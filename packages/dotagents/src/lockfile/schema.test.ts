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
