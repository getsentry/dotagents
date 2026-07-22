import { describe, expect, it } from "vitest";
import type { WildcardSkillDependency } from "../config/schema.js";
import type { LockedSkill } from "./schema.js";
import { wildcardContainsLockedSkill } from "./wildcard.js";

const wildcard: WildcardSkillDependency = {
  name: "*",
  source: "org/repo",
  path: "skills/engineering",
  exclude: [],
};

function locked(resolvedPath?: string): LockedSkill {
  return {
    source: "org/repo",
    resolved_url: "https://github.com/org/repo.git",
    resolved_path: resolvedPath ?? "skills/engineering/review",
  };
}

describe("wildcardContainsLockedSkill", () => {
  it.each([
    ["exact scope", "skills/engineering", true],
    ["nested skill", "skills/engineering/platform/review", true],
    ["sibling prefix", "skills/engineering-tools/review", false],
    ["unrelated path", "skills/productivity/notes", false],
  ])("handles %s", (_description, resolvedPath, expected) => {
    expect(wildcardContainsLockedSkill(wildcard, "review", locked(resolvedPath))).toBe(expected);
  });

  it("retains legacy entries without resolved paths", () => {
    const legacy: LockedSkill = { source: "org/repo" };

    expect(wildcardContainsLockedSkill(wildcard, "review", legacy)).toBe(true);
  });
});
