import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runSync } from "./sync.js";
import { runInstall } from "./install.js";
import { runRemove } from "./remove.js";
import { writeLockfile } from "../../lockfile/writer.js";
import { loadLockfile } from "../../lockfile/loader.js";
import { loadConfig } from "../../config/loader.js";
import { resolveScope } from "../../scope.js";
import { exec } from "../../utils/exec.js";

const SKILL_MD = (name: string) => `---
name: ${name}
description: Test skill ${name}
---
`;

describe("runSync", () => {
  let tmpDir: string;
  let projectRoot: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dotagents-sync-"));
    projectRoot = join(tmpDir, "project");
    await mkdir(join(projectRoot, ".agents", "skills"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true });
  });

  it("adopts orphaned skill into agents.toml and agents.lock", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      "version = 1\n",
    );
    const orphanDir = join(projectRoot, ".agents", "skills", "orphan");
    await mkdir(orphanDir, { recursive: true });
    await writeFile(join(orphanDir, "SKILL.md"), SKILL_MD("orphan"));

    const result = await runSync({ scope: resolveScope("project", projectRoot) });

    // Should be adopted, not reported as an issue
    expect(result.adopted).toEqual(["orphan"]);
    expect(result.issues).toHaveLength(0);

    // agents.toml should now declare the skill with path: source
    const config = await loadConfig(join(projectRoot, "agents.toml"));
    const skill = config.skills.find((s) => s.name === "orphan");
    expect(skill).toBeDefined();
    expect(skill!.source).toBe("path:.agents/skills/orphan");

    // agents.lock should track the skill
    const lockfile = await loadLockfile(join(projectRoot, "agents.lock"));
    expect(lockfile).not.toBeNull();
    expect(lockfile!.skills["orphan"]).toBeDefined();
    expect(lockfile!.skills["orphan"]!.source).toBe("path:.agents/skills/orphan");
  });

  it("adopts multiple orphans in one sync", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      "version = 1\n",
    );
    for (const name of ["alpha", "beta"]) {
      const dir = join(projectRoot, ".agents", "skills", name);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "SKILL.md"), SKILL_MD(name));
    }

    const result = await runSync({ scope: resolveScope("project", projectRoot) });
    expect(result.adopted).toHaveLength(2);
    expect(result.adopted).toContain("alpha");
    expect(result.adopted).toContain("beta");

    const config = await loadConfig(join(projectRoot, "agents.toml"));
    expect(config.skills).toHaveLength(2);
  });

  it("adopted skill does not appear as orphan issue", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      "version = 1\n",
    );
    const orphanDir = join(projectRoot, ".agents", "skills", "stray");
    await mkdir(orphanDir, { recursive: true });
    await writeFile(join(orphanDir, "SKILL.md"), SKILL_MD("stray"));

    const result = await runSync({ scope: resolveScope("project", projectRoot) });
    expect(result.adopted).toContain("stray");
    expect(result.issues).toHaveLength(0);
  });

  it("prunes stale managed skills removed from config instead of re-adopting them", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      "version = 1\n",
    );
    const managedDir = join(projectRoot, ".agents", "skills", "pdf");
    await mkdir(managedDir, { recursive: true });
    await writeFile(join(managedDir, "SKILL.md"), SKILL_MD("pdf"));
    await writeLockfile(join(projectRoot, "agents.lock"), {
      version: 1,
      skills: {
        pdf: {
          source: "org/repo",
          resolved_url: "https://github.com/org/repo.git",
          resolved_path: "pdf",
        },
      },
    });

    const result = await runSync({ scope: resolveScope("project", projectRoot) });

    expect(result.adopted).toHaveLength(0);
    expect(result.pruned).toEqual(["pdf"]);
    expect(existsSync(managedDir)).toBe(false);

    const config = await loadConfig(join(projectRoot, "agents.toml"));
    expect(config.skills).toHaveLength(0);

    const lockfile = await loadLockfile(join(projectRoot, "agents.lock"));
    expect(lockfile).not.toBeNull();
    expect(lockfile!.skills["pdf"]).toBeUndefined();
  });

  it("prunes wildcard skills newly excluded from config", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "*"\nsource = "org/repo"\nexclude = ["review"]\n`,
    );
    const reviewDir = join(projectRoot, ".agents", "skills", "review");
    await mkdir(reviewDir, { recursive: true });
    await writeFile(join(reviewDir, "SKILL.md"), SKILL_MD("review"));
    await writeLockfile(join(projectRoot, "agents.lock"), {
      version: 1,
      skills: {
        review: {
          source: "org/repo",
          resolved_url: "https://github.com/org/repo.git",
          resolved_path: "skills/review",
        },
      },
    });

    const result = await runSync({ scope: resolveScope("project", projectRoot) });

    expect(result.adopted).toHaveLength(0);
    expect(result.pruned).toEqual(["review"]);
    expect(existsSync(reviewDir)).toBe(false);
  });

  it("prunes stale managed skills after a collaborator removes the dependency and another collaborator pulls", async () => {
    const skillRepo = join(tmpDir, "skill-repo");
    const projectOrigin = join(tmpDir, "project-origin.git");
    const projectSeed = join(tmpDir, "project-seed");
    const aliceRepo = join(tmpDir, "alice");
    const bobRepo = join(tmpDir, "bob");
    const aliceStateDir = join(tmpDir, "alice-state");
    const bobStateDir = join(tmpDir, "bob-state");

    const previousStateDir = process.env["DOTAGENTS_STATE_DIR"];

    await mkdir(skillRepo, { recursive: true });
    await exec("git", ["init"], { cwd: skillRepo });
    await exec("git", ["config", "user.email", "test@example.com"], { cwd: skillRepo });
    await exec("git", ["config", "user.name", "Test User"], { cwd: skillRepo });
    await mkdir(join(skillRepo, "pdf"), { recursive: true });
    await writeFile(join(skillRepo, "pdf", "SKILL.md"), SKILL_MD("pdf"));
    await exec("git", ["add", "."], { cwd: skillRepo });
    await exec("git", ["commit", "-m", "initial skill"], { cwd: skillRepo });

    await exec("git", ["init", "--bare", projectOrigin], { cwd: tmpDir });
    await mkdir(projectSeed, { recursive: true });
    await exec("git", ["init", "-b", "main"], { cwd: projectSeed });
    await exec("git", ["config", "user.email", "test@example.com"], { cwd: projectSeed });
    await exec("git", ["config", "user.name", "Test User"], { cwd: projectSeed });
    await writeFile(
      join(projectSeed, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "pdf"\nsource = "git:${skillRepo}"\n`,
    );
    await exec("git", ["add", "agents.toml"], { cwd: projectSeed });
    await exec("git", ["commit", "-m", "initial project config"], { cwd: projectSeed });
    await exec("git", ["remote", "add", "origin", projectOrigin], { cwd: projectSeed });
    await exec("git", ["push", "-u", "origin", "main"], { cwd: projectSeed });

    await exec("git", ["clone", "--branch", "main", projectOrigin, aliceRepo], { cwd: tmpDir });
    await exec("git", ["clone", "--branch", "main", projectOrigin, bobRepo], { cwd: tmpDir });
    await exec("git", ["config", "user.email", "alice@example.com"], { cwd: aliceRepo });
    await exec("git", ["config", "user.name", "Alice"], { cwd: aliceRepo });
    await exec("git", ["config", "user.email", "bob@example.com"], { cwd: bobRepo });
    await exec("git", ["config", "user.name", "Bob"], { cwd: bobRepo });

    try {
      process.env["DOTAGENTS_STATE_DIR"] = aliceStateDir;
      await runInstall({ scope: resolveScope("project", aliceRepo) });

      process.env["DOTAGENTS_STATE_DIR"] = bobStateDir;
      await runInstall({ scope: resolveScope("project", bobRepo) });

      const bobSkillDir = join(bobRepo, ".agents", "skills", "pdf");
      expect(existsSync(bobSkillDir)).toBe(true);

      process.env["DOTAGENTS_STATE_DIR"] = aliceStateDir;
      await runRemove({ scope: resolveScope("project", aliceRepo), skillName: "pdf" });
      await exec("git", ["add", "agents.toml"], { cwd: aliceRepo });
      await exec("git", ["commit", "-m", "remove pdf"], { cwd: aliceRepo });
      await exec("git", ["push", "origin", "main"], { cwd: aliceRepo });

      await exec("git", ["pull", "--ff-only", "origin", "main"], { cwd: bobRepo });

      const bobConfig = await loadConfig(join(bobRepo, "agents.toml"));
      expect(bobConfig.skills).toHaveLength(0);
      expect(existsSync(bobSkillDir)).toBe(true);

      const bobLockBeforeSync = await loadLockfile(join(bobRepo, "agents.lock"));
      expect(bobLockBeforeSync!.skills["pdf"]).toBeDefined();

      process.env["DOTAGENTS_STATE_DIR"] = bobStateDir;
      const result = await runSync({ scope: resolveScope("project", bobRepo) });

      expect(result.adopted).toHaveLength(0);
      expect(result.pruned).toEqual(["pdf"]);
      expect(existsSync(bobSkillDir)).toBe(false);

      const bobLockAfterSync = await loadLockfile(join(bobRepo, "agents.lock"));
      expect(bobLockAfterSync).not.toBeNull();
      expect(bobLockAfterSync!.skills["pdf"]).toBeUndefined();
    } finally {
      if (previousStateDir === undefined) {
        delete process.env["DOTAGENTS_STATE_DIR"];
      } else {
        process.env["DOTAGENTS_STATE_DIR"] = previousStateDir;
      }
    }
  });

  it("detects missing skills", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "pdf"\nsource = "org/repo"\n`,
    );

    const result = await runSync({ scope: resolveScope("project", projectRoot) });
    const missingIssues = result.issues.filter((i) => i.type === "missing");
    expect(missingIssues).toHaveLength(1);
    expect(missingIssues[0]!.name).toBe("pdf");
  });

  it("reports no issues when everything is in sync", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "pdf"\nsource = "org/repo"\n`,
    );
    const skillDir = join(projectRoot, ".agents", "skills", "pdf");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), SKILL_MD("pdf"));

    await writeLockfile(join(projectRoot, "agents.lock"), {
      version: 1,
      skills: {
        pdf: {
          source: "org/repo",
          resolved_url: "https://github.com/org/repo.git",
          resolved_path: "pdf",
        },
      },
    });

    const result = await runSync({ scope: resolveScope("project", projectRoot) });
    expect(result.issues).toHaveLength(0);
  });

  it("matches GitLab wildcard sources using defaultRepositorySource", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\ndefaultRepositorySource = "gitlab"\n\n[[skills]]\nname = "*"\nsource = "group/repo"\n`,
    );
    const skillDir = join(projectRoot, ".agents", "skills", "find-bugs");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), SKILL_MD("find-bugs"));

    await writeLockfile(join(projectRoot, "agents.lock"), {
      version: 1,
      skills: {
        "find-bugs": {
          source: "https://gitlab.com/group/repo",
          resolved_url: "https://gitlab.com/group/repo.git",
          resolved_path: "find-bugs",
        },
      },
    });

    const result = await runSync({ scope: resolveScope("project", projectRoot) });
    expect(result.issues).toHaveLength(0);
  });

  it("repairs broken symlinks", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[symlinks]\ntargets = [".claude"]\n`,
    );

    // Create .claude dir without the symlink
    await mkdir(join(projectRoot, ".claude"), { recursive: true });

    const result = await runSync({ scope: resolveScope("project", projectRoot) });
    expect(result.symlinksRepaired).toBe(1);
  });

  it("regenerates gitignore", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "pdf"\nsource = "org/repo"\n`,
    );

    const result = await runSync({ scope: resolveScope("project", projectRoot) });
    expect(result.gitignoreUpdated).toBe(true);

    const gitignore = await readFile(
      join(projectRoot, ".agents", ".gitignore"),
      "utf-8",
    );
    expect(gitignore).toContain("/skills/pdf/");
  });

  it("repairs missing MCP configs", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\nagents = ["claude"]\n\n[[mcp]]\nname = "github"\ncommand = "npx"\nargs = ["-y", "@mcp/server-github"]\n`,
    );

    const result = await runSync({ scope: resolveScope("project", projectRoot) });
    expect(result.mcpRepaired).toBeGreaterThan(0);

    // Verify config was created
    expect(existsSync(join(projectRoot, ".mcp.json"))).toBe(true);
  });

  it("repairs agent-specific symlinks", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\nagents = ["claude"]\n`,
    );

    // .claude dir exists but no symlink
    await mkdir(join(projectRoot, ".claude"), { recursive: true });

    const result = await runSync({ scope: resolveScope("project", projectRoot) });
    expect(result.symlinksRepaired).toBe(1);
  });

  it("repairs missing hook configs", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\nagents = ["claude"]\n\n[[hooks]]\nevent = "PreToolUse"\nmatcher = "Bash"\ncommand = ".agents/hooks/block-rm.sh"\n`,
    );

    const result = await runSync({ scope: resolveScope("project", projectRoot) });
    expect(result.hooksRepaired).toBeGreaterThan(0);

    // Verify config was created
    expect(existsSync(join(projectRoot, ".claude", "settings.json"))).toBe(true);

    const settings = JSON.parse(await readFile(join(projectRoot, ".claude", "settings.json"), "utf-8"));
    expect(settings.hooks.PreToolUse).toBeDefined();
  });

  it("reports no hook issues when configs are present", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\nagents = ["claude"]\n\n[[hooks]]\nevent = "Stop"\ncommand = "check.sh"\n`,
    );

    // First sync to create the config
    await runSync({ scope: resolveScope("project", projectRoot) });

    // Second sync should find everything in order
    const result = await runSync({ scope: resolveScope("project", projectRoot) });
    expect(result.hooksRepaired).toBe(0);
    expect(result.issues.filter((i) => i.type === "hooks")).toHaveLength(0);
  });

  it("warns when agents.lock is not in root .gitignore", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "pdf"\nsource = "org/repo"\n`,
    );

    await runSync({ scope: resolveScope("project", projectRoot) });

    // Should not auto-create .gitignore (only init does that)
    expect(existsSync(join(projectRoot, ".gitignore"))).toBe(false);
  });
});
