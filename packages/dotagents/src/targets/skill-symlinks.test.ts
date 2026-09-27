import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveScope } from "../scope.js";
import { perSkillLinkTargets, skillSymlinkTargets } from "./skill-symlinks.js";

describe("skillSymlinkTargets", () => {
  it("returns legacy targets before deduplicated agent targets", () => {
    const scope = resolveScope("project", "/workspace/project");

    expect(
      skillSymlinkTargets(
        scope,
        ["claude", "cursor", "codex"],
        [".legacy", ".claude", ".legacy"],
      ),
    ).toEqual([
      join(scope.root, ".legacy"),
      join(scope.root, ".claude"),
    ]);
  });

  it("returns deduplicated user targets, skipping native readers and per-skill clients", () => {
    const scope = resolveScope("user");

    expect(
      skillSymlinkTargets(
        scope,
        ["claude", "cursor", "codex", "vscode", "opencode", "copilot"],
        [".legacy"],
      ),
    ).toEqual([
      process.env["COPILOT_HOME"] || join(homedir(), ".copilot"),
    ]);
    expect(perSkillLinkTargets(scope, ["claude", "cursor", "codex", "opencode"])).toEqual([
      join(homedir(), ".claude"),
    ]);
    expect(perSkillLinkTargets(resolveScope("project", "relative/project"), ["claude"])).toEqual([]);
  });

  it("rejects absolute project targets", () => {
    const scope = resolveScope("project", "relative/project");

    expect(() => skillSymlinkTargets(scope, ["claude"], ["/legacy"]))
      .toThrow(/outside the project root/);
  });

  it("rejects project targets that resolve outside through a symlink", () => {
    const root = mkdtempSync(join(tmpdir(), "skill-target-containment-test-"));
    const project = join(root, "project");
    const outside = join(root, "outside");
    mkdirSync(project);
    mkdirSync(outside);
    symlinkSync(outside, join(project, ".legacy"), process.platform === "win32" ? "junction" : "dir");

    const scope = resolveScope("project", project);
    expect(() => skillSymlinkTargets(scope, [], [".legacy"]))
      .toThrow(/outside the project root/);

    rmSync(root, { recursive: true, force: true });
  });
});
