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
});

