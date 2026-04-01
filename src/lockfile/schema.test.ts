import { describe, it, expect } from "vitest";
import { lockfileSchema } from "./schema.js";

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
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid version", () => {
    expect(lockfileSchema.safeParse({ version: 2 }).success).toBe(false);
  });

  it("parses git skills without resolved_ref", () => {
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

  it("parses git skills with resolved_commit", () => {
    const result = lockfileSchema.safeParse({
      version: 1,
      skills: {
        "my-skill": {
          source: "org/repo",
          resolved_url: "https://github.com/org/repo.git",
          resolved_path: "my-skill",
          resolved_commit: "405638a2ee3f131b910be238af499eac5c86e92c",
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("parses git skills without resolved_commit (backwards compat)", () => {
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
});

