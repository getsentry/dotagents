import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveScope } from "../scope.js";
import { skillSymlinkTargets } from "./skill-symlinks.js";

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

  it("returns deduplicated user targets and skips native readers", () => {
    const scope = resolveScope("user");

    expect(
      skillSymlinkTargets(
        scope,
        ["claude", "cursor", "codex", "vscode", "opencode", "copilot"],
        [".legacy"],
      ),
    ).toEqual([join(homedir(), ".claude")]);
  });

  it("returns absolute project targets for a relative scope root", () => {
    const scope = resolveScope("project", "relative/project");

    expect(
      skillSymlinkTargets(scope, ["claude"], ["/legacy"]),
    ).toEqual([
      resolve(join("relative/project", "/legacy")),
      resolve(join("relative/project", ".claude")),
    ]);
  });
});
