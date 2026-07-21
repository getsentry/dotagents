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
});
