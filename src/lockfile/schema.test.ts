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
});
