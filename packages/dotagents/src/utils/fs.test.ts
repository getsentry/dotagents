import { describe, expect, it } from "vitest";
import { join, resolve } from "node:path";
import { managedSkillPath } from "./fs.js";

describe("managedSkillPath", () => {
  it("resolves safe skill names inside the skills directory", () => {
    const skillsDir = join("project", ".agents", "skills");

    expect(managedSkillPath(skillsDir, "pdf")).toBe(resolve(skillsDir, "pdf"));
  });

  it("rejects path-shaped skill names", () => {
    const skillsDir = join("project", ".agents", "skills");

    expect(managedSkillPath(skillsDir, "../hooks")).toBeNull();
    expect(managedSkillPath(skillsDir, "stale/../pdf")).toBeNull();
    expect(managedSkillPath(skillsDir, "foo/bar")).toBeNull();
  });
});
