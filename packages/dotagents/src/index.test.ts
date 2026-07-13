import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { discoverSkill, discoverAllSkills } from "./index.js";

const SKILL_MD = (name: string) =>
  `---\nname: ${name}\ndescription: ${name} skill\n---\n`;

/**
 * The host's deprecated re-exports of `discoverSkill`/`discoverAllSkills`
 * must preserve the dotagents scan-dir conventions (`.agents/skills/`,
 * `.claude/skills/`) so external consumers using the deprecated path
 * don't silently get fewer results.
 *
 * Lib consumers calling `@sentry/dotagents-lib` directly still get the
 * canonical `["skills"]` default — that's tested in the lib's discovery test.
 */
describe("host re-exports preserve dotagents scan dirs", () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await mkdtemp(join(tmpdir(), "dotagents-host-discover-"));
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it("discoverSkill finds skills under both host scan dirs", async () => {
    await mkdir(join(repoDir, ".agents", "skills", "lint"), { recursive: true });
    await writeFile(join(repoDir, ".agents", "skills", "lint", "SKILL.md"), SKILL_MD("lint"));
    await mkdir(join(repoDir, ".claude", "skills", "commit"), { recursive: true });
    await writeFile(join(repoDir, ".claude", "skills", "commit", "SKILL.md"), SKILL_MD("commit"));

    const agentsSkill = await discoverSkill(repoDir, "lint");
    expect(agentsSkill?.path).toBe(".agents/skills/lint");

    const claudeSkill = await discoverSkill(repoDir, "commit");
    expect(claudeSkill?.path).toBe(".claude/skills/commit");
  });

  it("discoverAllSkills walks .agents/skills/ and .claude/skills/", async () => {
    await mkdir(join(repoDir, ".agents", "skills", "lint"), { recursive: true });
    await writeFile(join(repoDir, ".agents", "skills", "lint", "SKILL.md"), SKILL_MD("lint"));
    await mkdir(join(repoDir, ".claude", "skills", "commit"), { recursive: true });
    await writeFile(join(repoDir, ".claude", "skills", "commit", "SKILL.md"), SKILL_MD("commit"));

    const results = await discoverAllSkills(repoDir);
    const names = results.map((r) => r.meta.name).toSorted();
    expect(names).toEqual(["commit", "lint"]);
  });
});
