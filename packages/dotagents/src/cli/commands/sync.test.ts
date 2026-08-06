import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { lstat, mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
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
import { DOTAGENTS_SUBAGENT_MARKER } from "../../subagents/format.js";
import { exec } from "@sentry/dotagents-lib";

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

  it("does not report malformed stale skill names as pruned", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      "version = 1\n",
    );
    const managedDir = join(projectRoot, ".agents", "skills", "bad name");
    await mkdir(managedDir, { recursive: true });
    await writeFile(join(managedDir, "SKILL.md"), SKILL_MD("bad name"));
    await writeLockfile(join(projectRoot, "agents.lock"), {
      version: 1,
      skills: {
        "bad name": {
          source: "org/repo",
          resolved_url: "https://github.com/org/repo.git",
          resolved_path: "bad-name",
        },
      },
    });

    const result = await runSync({ scope: resolveScope("project", projectRoot) });

    expect(result.adopted).toHaveLength(0);
    expect(result.pruned).toHaveLength(0);
    expect(existsSync(managedDir)).toBe(true);

    const lockfile = await loadLockfile(join(projectRoot, "agents.lock"));
    expect(lockfile).not.toBeNull();
    expect(lockfile!.skills["bad name"]).toBeDefined();
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

  it("prunes wildcard skills outside the configured path", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "*"\nsource = "org/repo"\npath = "skills/engineering/"\n`,
    );
    const deployDir = join(projectRoot, ".agents", "skills", "deploy");
    const notesDir = join(projectRoot, ".agents", "skills", "notes");
    await mkdir(deployDir, { recursive: true });
    await mkdir(notesDir, { recursive: true });
    await writeFile(join(deployDir, "SKILL.md"), SKILL_MD("deploy"));
    await writeFile(join(notesDir, "SKILL.md"), SKILL_MD("notes"));
    await writeLockfile(join(projectRoot, "agents.lock"), {
      version: 1,
      skills: {
        deploy: {
          source: "org/repo",
          resolved_url: "https://github.com/org/repo.git",
          resolved_path: "skills/engineering/deploy",
        },
        notes: {
          source: "org/repo",
          resolved_url: "https://github.com/org/repo.git",
          resolved_path: "skills/productivity/notes",
        },
      },
    });

    const result = await runSync({ scope: resolveScope("project", projectRoot) });

    expect(result.pruned).toEqual(["notes"]);
    expect(existsSync(deployDir)).toBe(true);
    expect(existsSync(notesDir)).toBe(false);
    const lockfile = await loadLockfile(join(projectRoot, "agents.lock"));
    expect(lockfile!.skills["deploy"]).toBeDefined();
    expect(lockfile!.skills["notes"]).toBeUndefined();
  });

  it("retains legacy wildcard entries without resolved paths", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "*"\nsource = "path:local-skills"\npath = "engineering"\n`,
    );
    const reviewDir = join(projectRoot, ".agents", "skills", "review");
    await mkdir(reviewDir, { recursive: true });
    await writeFile(join(reviewDir, "SKILL.md"), SKILL_MD("review"));
    await writeLockfile(join(projectRoot, "agents.lock"), {
      version: 1,
      skills: {
        review: { source: "path:local-skills" },
      },
    });

    const result = await runSync({ scope: resolveScope("project", projectRoot) });

    expect(result.pruned).toEqual([]);
    expect(result.adopted).toEqual([]);
    expect(existsSync(reviewDir)).toBe(true);
  });

  it("matches backslash wildcard paths against canonical lock paths", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "*"\nsource = "org/repo"\npath = "skills\\\\engineering"\n`,
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
          resolved_path: "skills/engineering/review",
        },
      },
    });

    const result = await runSync({ scope: resolveScope("project", projectRoot) });

    expect(result.pruned).toEqual([]);
    expect(existsSync(reviewDir)).toBe(true);
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
    await exec("git", ["config", "commit.gpgsign", "false"], { cwd: skillRepo });
    await mkdir(join(skillRepo, "pdf"), { recursive: true });
    await writeFile(join(skillRepo, "pdf", "SKILL.md"), SKILL_MD("pdf"));
    await exec("git", ["add", "."], { cwd: skillRepo });
    await exec("git", ["commit", "-m", "initial skill"], { cwd: skillRepo });

    await exec("git", ["init", "--bare", projectOrigin], { cwd: tmpDir });
    await mkdir(projectSeed, { recursive: true });
    await exec("git", ["init", "-b", "main"], { cwd: projectSeed });
    await exec("git", ["config", "user.email", "test@example.com"], { cwd: projectSeed });
    await exec("git", ["config", "user.name", "Test User"], { cwd: projectSeed });
    await exec("git", ["config", "commit.gpgsign", "false"], { cwd: projectSeed });
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
    await exec("git", ["config", "commit.gpgsign", "false"], { cwd: aliceRepo });
    await exec("git", ["config", "user.email", "bob@example.com"], { cwd: bobRepo });
    await exec("git", ["config", "user.name", "Bob"], { cwd: bobRepo });
    await exec("git", ["config", "commit.gpgsign", "false"], { cwd: bobRepo });

    try {
      process.env["DOTAGENTS_STATE_DIR"] = aliceStateDir;
      await runInstall({ scope: resolveScope("project", aliceRepo) });

      process.env["DOTAGENTS_STATE_DIR"] = bobStateDir;
      await runInstall({ scope: resolveScope("project", bobRepo) });

      const bobSkillDir = join(bobRepo, ".agents", "skills", "pdf");
      expect(existsSync(bobSkillDir)).toBe(true);

      process.env["DOTAGENTS_STATE_DIR"] = aliceStateDir;
      await runRemove({ scope: resolveScope("project", aliceRepo), name: "pdf" });
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
  }, 90_000);

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

  it("detects missing plugins as errors", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1

[[plugins]]
name = "review-tools"
source = "path:plugin-source/review-tools"
`,
    );

    const result = await runSync({ scope: resolveScope("project", projectRoot) });
    expect(result.issues).toEqual([
      {
        type: "missing",
        name: "review-tools",
        message: `Plugin "review-tools" is in agents.toml but not installed. Run 'npx @sentry/dotagents install'.`,
      },
    ]);
  });

  it("preserves plugin names for malformed installed bundle issues", async () => {
    const pluginDir = join(projectRoot, ".agents", "plugins", "review-tools");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(join(pluginDir, "plugin.json"), "not json");
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1

[[plugins]]
name = "review-tools"
source = "path:plugin-source/review-tools"
`,
    );

    const result = await runSync({ scope: resolveScope("project", projectRoot) });

    expect(result.issues).toContainEqual({
      type: "plugins",
      name: "review-tools",
      message: expect.stringContaining('Failed to load installed plugin "review-tools"'),
    });
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
    expect((await lstat(join(projectRoot, ".claude", "skills"))).isSymbolicLink()).toBe(true);
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
    expect(gitignore).toContain("/skills/pdf");
  });

  it("does not gitignore orphan skills that collide with Pi plugin projections", async () => {
    await mkdir(join(projectRoot, ".agents", "skills", "review"), { recursive: true });
    await writeFile(join(projectRoot, ".agents", "skills", "review", "SKILL.md"), SKILL_MD("review"));
    const pluginDir = join(projectRoot, ".agents", "plugins", "review-tools");
    await mkdir(join(pluginDir, "skills", "review"), { recursive: true });
    await writeFile(join(pluginDir, "plugin.json"), JSON.stringify({ name: "review-tools" }, null, 2));
    await writeFile(join(pluginDir, "skills", "review", "SKILL.md"), SKILL_MD("review"));
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1
agents = ["pi"]

[[plugins]]
name = "review-tools"
source = "path:plugin-source/review-tools"
`,
    );

    await runSync({ scope: resolveScope("project", projectRoot) });

    const gitignore = await readFile(join(projectRoot, ".agents", ".gitignore"), "utf-8");
    expect(gitignore).not.toContain("/skills/review");
    expect(gitignore).toContain("/plugins/review-tools/");
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

  it("repairs MCP transport drift under unchanged server names", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1
agents = ["claude"]

[[mcp]]
name = "github"
command = "npx"
args = ["-y", "@mcp/server-github"]
env = ["GITHUB_TOKEN"]

[[mcp]]
name = "remote"
url = "https://mcp.example.com/sse"
headers = { Authorization = "Bearer tok" }
`,
    );
    const configPath = join(projectRoot, "agents.toml");
    const mcpPath = join(projectRoot, ".mcp.json");
    await writeFile(mcpPath, JSON.stringify({
      editor: "manual",
      mcpServers: {
        manual: { command: "manual" },
        github: { command: "old", args: ["old"], env: { GITHUB_TOKEN: "old" } },
        remote: { type: "http", url: "https://old.example.com", headers: { Authorization: "old" } },
      },
    }));

    const result = await runSync({ scope: resolveScope("project", projectRoot) });

    expect(result.mcpRepaired).toBe(1);
    expect(result.issues.filter(({ type }) => type === "mcp")).toEqual([]);
    expect(JSON.parse(await readFile(mcpPath, "utf-8"))).toEqual({
      editor: "manual",
      mcpServers: {
        manual: { command: "manual" },
        github: {
          command: "npx",
          args: ["-y", "@mcp/server-github"],
          env: { GITHUB_TOKEN: "${GITHUB_TOKEN}" },
        },
        remote: {
          type: "http",
          url: "https://mcp.example.com/sse",
          headers: { Authorization: "Bearer tok" },
        },
      },
    });

    await writeFile(configPath, `version = 1\nagents = ["claude"]\n`);
    const beforeEmptySync = await readFile(mcpPath, "utf-8");
    const emptyResult = await runSync({ scope: resolveScope("project", projectRoot) });
    expect(emptyResult.mcpRepaired).toBe(0);
    expect(await readFile(mcpPath, "utf-8")).toBe(beforeEmptySync);

    await writeFile(configPath, `version = 1\nagents = ["claude"]\n\n[[mcp]]\nname = "github"\ncommand = "npx"\n`);
    const incompatible = '{"mcpServers":[]}\n';
    await writeFile(mcpPath, incompatible);
    const incompatibleResult = await runSync({ scope: resolveScope("project", projectRoot) });
    expect(incompatibleResult.mcpRepaired).toBe(0);
    expect(incompatibleResult.issues).toEqual([{
      type: "mcp",
      name: "claude",
      message: `Failed to read MCP config: ${mcpPath}`,
    }]);
    expect(await readFile(mcpPath, "utf-8")).toBe(incompatible);
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
    expect((await lstat(join(projectRoot, ".claude", "skills"))).isSymbolicLink()).toBe(true);
  });

  it("reconciles missing and drifted hook configs without removing empty declarations", async () => {
    const configPath = join(projectRoot, "agents.toml");
    const settingsPath = join(projectRoot, ".claude", "settings.json");
    await writeFile(
      configPath,
      `version = 1\nagents = ["claude"]\n\n[[hooks]]\nevent = "PreToolUse"\nmatcher = "Bash"\ncommand = ".agents/hooks/block-rm.sh"\n`,
    );

    const scope = resolveScope("project", projectRoot);
    const missing = await runSync({ scope });
    expect(missing.hooksRepaired).toBe(1);
    const settings = JSON.parse(await readFile(settingsPath, "utf-8"));
    expect(settings.hooks.PreToolUse).toBeDefined();

    await writeFile(settingsPath, JSON.stringify({
      permissions: { allow: ["Read"] },
      hooks: { PreToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "old.sh" }] }] },
    }));
    const drifted = await runSync({ scope });
    expect(drifted.hooksRepaired).toBe(1);
    expect(drifted.issues.filter((issue) => issue.type === "hooks")).toEqual([]);
    expect(JSON.parse(await readFile(settingsPath, "utf-8"))).toEqual({
      permissions: { allow: ["Read"] },
      hooks: {
        PreToolUse: [{
          matcher: "Bash",
          hooks: [{ type: "command", command: ".agents/hooks/block-rm.sh" }],
        }],
      },
    });

    await writeFile(configPath, `version = 1\nagents = ["claude"]\n`);
    const unchanged = await runSync({ scope });
    expect(unchanged.hooksRepaired).toBe(0);
    expect(JSON.parse(await readFile(settingsPath, "utf-8"))).toEqual({
      permissions: { allow: ["Read"] },
      hooks: {
        PreToolUse: [{
          matcher: "Bash",
          hooks: [{ type: "command", command: ".agents/hooks/block-rm.sh" }],
        }],
      },
    });
  });

  it("repairs missing subagent configs", async () => {
    const installedDir = join(projectRoot, ".agents", "agents");
    await mkdir(installedDir, { recursive: true });
    await writeFile(
      join(installedDir, "reviewer.md"),
      `---\n# ${DOTAGENTS_SUBAGENT_MARKER}\nname: "reviewer"\ndescription: "Review code."\n---\n\nReview code.\n`,
      "utf-8",
    );

    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1
agents = ["claude"]

[[subagents]]
name = "reviewer"
source = "path:agents"
path = "reviewer.md"
`,
    );

    const result = await runSync({ scope: resolveScope("project", projectRoot) });
    expect(result.subagentsRepaired).toBe(1);
    expect(existsSync(join(projectRoot, ".claude", "agents", "reviewer.md"))).toBe(true);
  });

  it("reports unmanaged subagent config conflicts without overwriting them", async () => {
    const installedDir = join(projectRoot, ".agents", "agents");
    await mkdir(installedDir, { recursive: true });
    await writeFile(
      join(installedDir, "reviewer.md"),
      `---\n# ${DOTAGENTS_SUBAGENT_MARKER}\nname: "reviewer"\ndescription: "Review code."\n---\n\nReview code.\n`,
      "utf-8",
    );

    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1
agents = ["claude"]

[[subagents]]
name = "reviewer"
source = "path:agents"
path = "reviewer.md"
`,
    );
    const agentsDir = join(projectRoot, ".claude", "agents");
    await mkdir(agentsDir, { recursive: true });
    await writeFile(join(agentsDir, "reviewer.md"), "hand-written", "utf-8");

    const result = await runSync({ scope: resolveScope("project", projectRoot) });

    expect(result.subagentsRepaired).toBe(0);
    expect(result.issues.some((i) => i.type === "subagents" && i.message.includes("not managed"))).toBe(true);
    expect(await readFile(join(agentsDir, "reviewer.md"), "utf-8")).toBe("hand-written");
  });

  it("preserves declared managed subagent configs when an unmanaged identity conflict exists", async () => {
    const installedDir = join(projectRoot, ".agents", "agents");
    await mkdir(installedDir, { recursive: true });
    await writeFile(
      join(installedDir, "reviewer.md"),
      `---\n# ${DOTAGENTS_SUBAGENT_MARKER}\nname: "reviewer"\ndescription: "Review code."\n---\n\nReview code.\n`,
      "utf-8",
    );

    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1
agents = ["claude"]

[[subagents]]
name = "reviewer"
source = "path:agents"
path = "reviewer.md"
`,
    );
    const agentsDir = join(projectRoot, ".claude", "agents");
    await mkdir(agentsDir, { recursive: true });
    await writeFile(
      join(agentsDir, "reviewer.md"),
      `---\n# ${DOTAGENTS_SUBAGENT_MARKER}\nname: "reviewer"\ndescription: "Managed reviewer."\n---\n\nManaged instructions.\n`,
      "utf-8",
    );
    await writeFile(
      join(agentsDir, "alias.md"),
      `---\nname: reviewer\ndescription: Hand-written reviewer.\n---\n\nHand-written instructions.\n`,
      "utf-8",
    );

    const result = await runSync({ scope: resolveScope("project", projectRoot) });

    expect(result.subagentsRepaired).toBe(0);
    expect(result.issues.some((i) => i.type === "subagents" && i.message.includes("identity conflicts"))).toBe(true);
    expect(existsSync(join(agentsDir, "reviewer.md"))).toBe(true);
    expect(existsSync(join(agentsDir, "alias.md"))).toBe(true);
  });

  it("does not prune runtime files for declared subagents that are not installed", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1
agents = ["claude"]

[[subagents]]
name = "reviewer"
source = "path:agents"
path = "reviewer.md"
`,
    );
    const agentsDir = join(projectRoot, ".claude", "agents");
    await mkdir(agentsDir, { recursive: true });
    await writeFile(
      join(agentsDir, "reviewer.md"),
      `---\n# ${DOTAGENTS_SUBAGENT_MARKER}\nname: "reviewer"\ndescription: "Review code."\n---\n\nReview code.\n`,
      "utf-8",
    );

    const result = await runSync({ scope: resolveScope("project", projectRoot) });

    expect(result.issues.some((i) => i.type === "subagents" && i.message.includes("not installed"))).toBe(true);
    expect(result.subagentsRepaired).toBe(0);
    expect(existsSync(join(agentsDir, "reviewer.md"))).toBe(true);
  });

  it("reports pruned subagent configs as repaired", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1
agents = ["claude"]
`,
    );
    const agentsDir = join(projectRoot, ".claude", "agents");
    await mkdir(agentsDir, { recursive: true });
    await writeFile(
      join(agentsDir, "old-reviewer.md"),
      `---\n# ${DOTAGENTS_SUBAGENT_MARKER}\nname: "old-reviewer"\n---\n`,
      "utf-8",
    );

    const result = await runSync({ scope: resolveScope("project", projectRoot) });

    expect(result.subagentsRepaired).toBe(1);
    expect(existsSync(join(agentsDir, "old-reviewer.md"))).toBe(false);
  });

  it("prunes stale subagent lock entries", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1
agents = ["claude"]
`,
    );
    await writeLockfile(join(projectRoot, "agents.lock"), {
      version: 1,
      skills: {},
      subagents: {
        "old-reviewer": {
          source: "path:agents",
        },
      },
    });

    await runSync({ scope: resolveScope("project", projectRoot) });

    const lockfile = await loadLockfile(join(projectRoot, "agents.lock"));
    expect(lockfile!.subagents).toEqual({});
  });

  it("removes stale lockfile subagents when regenerating gitignore", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1
agents = ["claude"]
`,
    );
    await writeLockfile(join(projectRoot, "agents.lock"), {
      version: 1,
      skills: {},
      subagents: {
        "old-reviewer": {
          source: "path:agents",
        },
      },
    });
    await mkdir(join(projectRoot, ".agents", "agents"), { recursive: true });
    await writeFile(
      join(projectRoot, ".agents", "agents", "old-reviewer.md"),
      `---\n# ${DOTAGENTS_SUBAGENT_MARKER}\nname: "old-reviewer"\n---\n`,
      "utf-8",
    );

    await runSync({ scope: resolveScope("project", projectRoot) });

    const lockfile = await loadLockfile(join(projectRoot, "agents.lock"));
    expect(lockfile!.subagents).toEqual({});
    expect(existsSync(join(projectRoot, ".agents", "agents", "old-reviewer.md"))).toBe(false);

    const gitignore = await readFile(join(projectRoot, ".agents", ".gitignore"), "utf-8");
    expect(gitignore).not.toContain("/agents/old-reviewer.md");
  });

  it("repairs plugin runtime artifacts from installed plugin bundles", async () => {
    const pluginDir = join(projectRoot, ".agents", "plugins", "review-tools");
    await mkdir(join(pluginDir, "skills", "review"), { recursive: true });
    await writeFile(
      join(pluginDir, "plugin.json"),
      JSON.stringify({
        name: "review-tools",
        version: "1.0.0",
        description: "Review workflow helpers",
      }, null, 2),
    );
    await writeFile(join(pluginDir, "skills", "review", "SKILL.md"), SKILL_MD("review"));
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1
agents = ["codex", "claude", "cursor"]

[[plugins]]
name = "review-tools"
source = "path:plugin-source/review-tools"
`,
    );

    const result = await runSync({ scope: resolveScope("project", projectRoot) });

    expect(result.pluginsRepaired).toBeGreaterThan(0);
    expect(result.issues).toEqual([]);
    expect(existsSync(join(projectRoot, ".agents", "plugins", "marketplace.json"))).toBe(true);
    expect(existsSync(join(projectRoot, ".claude-plugin", "marketplace.json"))).toBe(true);
    expect(existsSync(join(projectRoot, ".cursor-plugin", "marketplace.json"))).toBe(true);
  });

  it("prunes removed native manifests before refreshing a surviving Grok copy", async () => {
    const pluginDir = join(projectRoot, ".agents", "plugins", "review-tools");
    await mkdir(join(pluginDir, "skills", "review"), { recursive: true });
    await writeFile(join(pluginDir, "plugin.json"), JSON.stringify({ name: "review-tools" }));
    await writeFile(join(pluginDir, "skills", "review", "SKILL.md"), SKILL_MD("review"));
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1
agents = ["claude", "grok"]

[[plugins]]
name = "review-tools"
source = "path:plugin-source/review-tools"
`,
    );

    const scope = resolveScope("project", projectRoot);
    await runSync({ scope });
    expect(existsSync(join(projectRoot, ".grok", "plugins", "review-tools", ".claude-plugin", "plugin.json"))).toBe(true);

    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1
agents = ["grok"]

[[plugins]]
name = "review-tools"
source = "path:plugin-source/review-tools"
`,
    );
    await runSync({ scope });

    expect(existsSync(join(pluginDir, ".claude-plugin", "plugin.json"))).toBe(false);
    expect(existsSync(join(projectRoot, ".grok", "plugins", "review-tools", ".claude-plugin", "plugin.json"))).toBe(false);
  });

  it("reports same-project plugins without generating runtime outputs", async () => {
    const pluginDir = join(projectRoot, ".agents", "plugins", "local-tools");
    await mkdir(join(pluginDir, "skills", "review"), { recursive: true });
    await writeFile(
      join(pluginDir, "plugin.json"),
      JSON.stringify({
        name: "local-tools",
        description: "Local plugin",
      }, null, 2),
    );
    await writeFile(join(pluginDir, "skills", "review", "SKILL.md"), SKILL_MD("review"));
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1
agents = ["codex"]

[[plugins]]
name = "local-tools"
source = "path:./.agents/plugins/local-tools"
`,
    );

    const result = await runSync({ scope: resolveScope("project", projectRoot) });

    expect(result.issues).toContainEqual({
      type: "plugins",
      name: "local-tools",
      message: 'Plugin "local-tools" resolves to .agents/plugins/local-tools. Same-project plugins cannot be installed into the same project; use an external source path or a separate repo.',
    });
    expect(existsSync(pluginDir)).toBe(true);
    expect(existsSync(join(projectRoot, ".agents", "plugins", "marketplace.json"))).toBe(false);
    expect(existsSync(join(pluginDir, ".codex-plugin", "plugin.json"))).toBe(false);
  });

  it("reports same-project plugins resolved through path aliases", async () => {
    const pluginDir = join(projectRoot, ".agents", "plugins", "local-tools");
    await mkdir(join(pluginDir, "skills", "review"), { recursive: true });
    await writeFile(join(pluginDir, "plugin.json"), JSON.stringify({ name: "local-tools" }, null, 2));
    await writeFile(join(pluginDir, "skills", "review", "SKILL.md"), SKILL_MD("review"));
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1
agents = ["codex"]

[[plugins]]
name = "local-tools"
source = "path:."
path = ".agents/plugins/local-tools"
`,
    );

    const result = await runSync({ scope: resolveScope("project", projectRoot) });

    expect(result.issues).toContainEqual({
      type: "plugins",
      name: "local-tools",
      message: 'Plugin "local-tools" resolves to .agents/plugins/local-tools. Same-project plugins cannot be installed into the same project; use an external source path or a separate repo.',
    });
    const gitignore = await readFile(join(projectRoot, ".agents", ".gitignore"), "utf-8");
    expect(gitignore).not.toContain("/plugins/local-tools/");
    expect(existsSync(join(projectRoot, ".agents", "plugins", "marketplace.json"))).toBe(false);
    expect(existsSync(join(pluginDir, ".codex-plugin", "plugin.json"))).toBe(false);
  });

  it("reports same-project plugins resolved through canonical discovery", async () => {
    const pluginDir = join(projectRoot, ".agents", "plugins", "local-tools");
    await mkdir(join(pluginDir, "skills", "review"), { recursive: true });
    await writeFile(join(pluginDir, "plugin.json"), JSON.stringify({ name: "local-tools" }, null, 2));
    await writeFile(join(pluginDir, "skills", "review", "SKILL.md"), SKILL_MD("review"));
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1
agents = ["codex"]

[[plugins]]
name = "local-tools"
source = "path:."
`,
    );

    const result = await runSync({ scope: resolveScope("project", projectRoot) });

    expect(result.issues).toContainEqual({
      type: "plugins",
      name: "local-tools",
      message: 'Plugin "local-tools" resolves to .agents/plugins/local-tools. Same-project plugins cannot be installed into the same project; use an external source path or a separate repo.',
    });
    const gitignore = await readFile(join(projectRoot, ".agents", ".gitignore"), "utf-8");
    expect(gitignore).not.toContain("/plugins/local-tools/");
    expect(existsSync(join(pluginDir, ".codex-plugin", "plugin.json"))).toBe(false);
  });

  it("only prunes stale managed plugin directories from the lockfile", async () => {
    await writeFile(join(projectRoot, "agents.toml"), "version = 1\n");
    await mkdir(join(projectRoot, ".agents", "plugins", "stale-managed"), { recursive: true });
    await mkdir(join(projectRoot, ".agents", "plugins", "local-unmanaged"), { recursive: true });
    await writeFile(
      join(projectRoot, ".agents", "plugins", "local-unmanaged", "plugin.json"),
      JSON.stringify({ name: "local-unmanaged" }, null, 2),
    );
    await writeLockfile(join(projectRoot, "agents.lock"), {
      version: 1,
      skills: {},
      subagents: {},
      plugins: {
        "stale-managed": {
          source: "getsentry/plugins",
          resolved_url: "https://github.com/getsentry/plugins.git",
          resolved_path: "stale-managed",
        },
      },
    });

    const result = await runSync({ scope: resolveScope("project", projectRoot) });

    expect(result.pluginsRepaired).toBe(1);
    expect(existsSync(join(projectRoot, ".agents", "plugins", "stale-managed"))).toBe(false);
    expect(existsSync(join(projectRoot, ".agents", "plugins", "local-unmanaged"))).toBe(true);
    const lockfile = await loadLockfile(join(projectRoot, "agents.lock"));
    expect(lockfile!.plugins).toEqual({});
  });

  it("does not auto-create root .gitignore", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "pdf"\nsource = "org/repo"\n`,
    );

    await runSync({ scope: resolveScope("project", projectRoot) });

    // Only init creates .gitignore — sync should not
    expect(existsSync(join(projectRoot, ".gitignore"))).toBe(false);
  });
});
