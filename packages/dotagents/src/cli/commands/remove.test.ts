import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  collectSkillsFromSource,
  RemoveError,
  runRemove,
  runRemovePluginSource,
  runRemoveSource,
  WildcardSkillRemoveError,
} from "./remove.js";
import { runInstall } from "./install.js";
import { exec } from "@sentry/dotagents-lib";
import { loadLockfile } from "../../lockfile/loader.js";
import { writeLockfile } from "../../lockfile/writer.js";
import { loadConfig } from "../../config/loader.js";
import { resolveScope } from "../../scope.js";
import { DOTAGENTS_MANAGED_PLUGIN_MARKER } from "../../plugins/store.js";

const SKILL_MD = (name: string) => `---
name: ${name}
description: Test skill ${name}
---
`;

describe("runRemove", () => {
  let tmpDir: string;
  let stateDir: string;
  let projectRoot: string;
  let repoDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dotagents-remove-"));
    stateDir = join(tmpDir, "state");
    projectRoot = join(tmpDir, "project");
    repoDir = join(tmpDir, "repo");

    process.env["DOTAGENTS_STATE_DIR"] = stateDir;

    await mkdir(join(projectRoot, ".agents", "skills"), { recursive: true });

    // Create a local git repo with skills
    await mkdir(repoDir, { recursive: true });
    await exec("git", ["init"], { cwd: repoDir });
    await exec("git", ["config", "user.email", "test@test.com"], { cwd: repoDir });
    await exec("git", ["config", "user.name", "Test"], { cwd: repoDir });
    await exec("git", ["config", "commit.gpgsign", "false"], { cwd: repoDir });

    await mkdir(join(repoDir, "pdf"), { recursive: true });
    await writeFile(join(repoDir, "pdf", "SKILL.md"), SKILL_MD("pdf"));

    await mkdir(join(repoDir, "skills", "review"), { recursive: true });
    await writeFile(join(repoDir, "skills", "review", "SKILL.md"), SKILL_MD("review"));

    await exec("git", ["add", "."], { cwd: repoDir });
    await exec("git", ["commit", "-m", "initial"], { cwd: repoDir });
  });

  afterEach(async () => {
    delete process.env["DOTAGENTS_STATE_DIR"];
    await rm(tmpDir, { recursive: true });
  });

  it("removes an explicit skill entry", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "pdf"\nsource = "git:${repoDir}"\n`,
    );
    const scope = resolveScope("project", projectRoot);
    await runInstall({ scope });

    await runRemove({ scope, name: "pdf" });

    const config = await loadConfig(join(projectRoot, "agents.toml"));
    expect(config.skills.find((s) => s.name === "pdf")).toBeUndefined();
    expect(existsSync(join(projectRoot, ".agents", "skills", "pdf"))).toBe(false);

    const lockfile = await loadLockfile(join(projectRoot, "agents.lock"));
    expect(lockfile!.skills["pdf"]).toBeUndefined();
  });

  it("keeps lockfile subagents in .agents/.gitignore after removing a skill", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "pdf"\nsource = "path:local-skills/pdf"\n`,
    );
    await mkdir(join(projectRoot, ".agents", "skills", "pdf"), { recursive: true });
    await writeFile(join(projectRoot, ".agents", "skills", "pdf", "SKILL.md"), SKILL_MD("pdf"));
    await writeLockfile(join(projectRoot, "agents.lock"), {
      version: 1,
      skills: {
        pdf: {
          source: "path:local-skills/pdf",
        },
      },
      subagents: {
        "old-reviewer": {
          source: "path:agents",
        },
      },
    });

    const scope = resolveScope("project", projectRoot);
    await runRemove({ scope, name: "pdf" });

    const gitignore = await readFile(join(projectRoot, ".agents", ".gitignore"), "utf-8");
    expect(gitignore).not.toContain("/skills/pdf");
    expect(gitignore).toContain("/agents/old-reviewer.md");
  });

  it("keeps managed plugins in .agents/.gitignore after removing a skill", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1

[[skills]]
name = "pdf"
source = "path:local-skills/pdf"

[[plugins]]
name = "review-tools"
source = "path:plugins/review-tools"
`,
    );
    await mkdir(join(projectRoot, ".agents", "skills", "pdf"), { recursive: true });
    await writeFile(join(projectRoot, ".agents", "skills", "pdf", "SKILL.md"), SKILL_MD("pdf"));
    await writeLockfile(join(projectRoot, "agents.lock"), {
      version: 1,
      skills: {
        pdf: {
          source: "path:local-skills/pdf",
        },
      },
      plugins: {
        "review-tools": {
          source: "path:plugins/review-tools",
        },
      },
    });

    const scope = resolveScope("project", projectRoot);
    await runRemove({ scope, name: "pdf" });

    const gitignore = await readFile(join(projectRoot, ".agents", ".gitignore"), "utf-8");
    expect(gitignore).not.toContain("/skills/pdf");
    expect(gitignore).toContain("/plugins/review-tools/");
    expect(gitignore).not.toContain("/plugins/marketplace.json");
  });

  it("does not gitignore same-project canonical plugins after removing a skill", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1

[[skills]]
name = "pdf"
source = "path:local-skills/pdf"

[[plugins]]
name = "local-tools"
source = "path:."
`,
    );
    await mkdir(join(projectRoot, ".agents", "skills", "pdf"), { recursive: true });
    await writeFile(join(projectRoot, ".agents", "skills", "pdf", "SKILL.md"), SKILL_MD("pdf"));
    const pluginDir = join(projectRoot, ".agents", "plugins", "local-tools");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(join(pluginDir, "plugin.json"), JSON.stringify({ name: "local-tools" }, null, 2));
    await writeLockfile(join(projectRoot, "agents.lock"), {
      version: 1,
      skills: {
        pdf: {
          source: "path:local-skills/pdf",
        },
      },
      plugins: {
        "local-tools": {
          source: "path:plugins/local-tools",
        },
      },
    });

    const scope = resolveScope("project", projectRoot);
    await runRemove({ scope, name: "pdf" });

    const gitignore = await readFile(join(projectRoot, ".agents", ".gitignore"), "utf-8");
    expect(gitignore).not.toContain("/skills/pdf");
    expect(gitignore).not.toContain("/plugins/local-tools/");
  });

  it("does not gitignore orphan skills that collide with Pi plugin projections after removing a skill", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1
agents = ["pi"]

[[skills]]
name = "pdf"
source = "path:local-skills/pdf"

[[plugins]]
name = "review-tools"
source = "path:plugins/review-tools"
`,
    );
    await mkdir(join(projectRoot, ".agents", "skills", "pdf"), { recursive: true });
    await writeFile(join(projectRoot, ".agents", "skills", "pdf", "SKILL.md"), SKILL_MD("pdf"));
    await mkdir(join(projectRoot, ".agents", "skills", "review"), { recursive: true });
    await writeFile(join(projectRoot, ".agents", "skills", "review", "SKILL.md"), SKILL_MD("review"));
    const pluginDir = join(projectRoot, ".agents", "plugins", "review-tools");
    await mkdir(join(pluginDir, "skills", "review"), { recursive: true });
    await writeFile(join(pluginDir, "plugin.json"), JSON.stringify({ name: "review-tools" }, null, 2));
    await writeFile(join(pluginDir, "skills", "review", "SKILL.md"), SKILL_MD("review"));
    await writeLockfile(join(projectRoot, "agents.lock"), {
      version: 1,
      skills: {
        pdf: {
          source: "path:local-skills/pdf",
        },
      },
      plugins: {
        "review-tools": {
          source: "path:plugins/review-tools",
        },
      },
    });

    const scope = resolveScope("project", projectRoot);
    await runRemove({ scope, name: "pdf" });

    const gitignore = await readFile(join(projectRoot, ".agents", ".gitignore"), "utf-8");
    expect(gitignore).not.toContain("/skills/review");
    expect(gitignore).toContain("/plugins/review-tools/");
  });

  it("removes a plugin entry, managed bundle, lock entry, and runtime outputs", async () => {
    const pluginSource = join(projectRoot, "plugins", "review-tools");
    await mkdir(join(pluginSource, "skills", "review"), { recursive: true });
    await writeFile(join(pluginSource, "plugin.json"), JSON.stringify({ name: "review-tools" }, null, 2));
    await writeFile(join(pluginSource, "skills", "review", "SKILL.md"), SKILL_MD("review"));
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1
agents = ["codex", "pi"]

[[plugins]]
name = "review-tools"
source = "path:plugins/review-tools"
`,
    );
    const scope = resolveScope("project", projectRoot);
    await runInstall({ scope });

    expect(existsSync(join(projectRoot, ".agents", "plugins", "review-tools"))).toBe(true);
    expect(existsSync(join(projectRoot, ".agents", "plugins", "marketplace.json"))).toBe(true);
    expect(existsSync(join(projectRoot, ".agents", "skills", "review"))).toBe(true);

    await runRemove({ scope, name: "review-tools" });

    const config = await loadConfig(join(projectRoot, "agents.toml"));
    expect(config.plugins.find((plugin) => plugin.name === "review-tools")).toBeUndefined();
    const lockfile = await loadLockfile(join(projectRoot, "agents.lock"));
    expect(lockfile!.plugins["review-tools"]).toBeUndefined();
    expect(existsSync(join(projectRoot, ".agents", "plugins", "review-tools"))).toBe(false);
    expect(existsSync(join(projectRoot, ".agents", "plugins", "marketplace.json"))).toBe(false);
    expect(existsSync(join(projectRoot, ".agents", "skills", "review"))).toBe(false);
  });

  it("removes both an explicit skill and plugin that share a name", async () => {
    const skillSource = join(projectRoot, "local-skills", "review-tools");
    await mkdir(skillSource, { recursive: true });
    await writeFile(join(skillSource, "SKILL.md"), SKILL_MD("review-tools"));

    const pluginSource = join(projectRoot, "plugins", "review-tools");
    await mkdir(join(pluginSource, "skills", "plugin-review"), { recursive: true });
    await writeFile(join(pluginSource, "plugin.json"), JSON.stringify({ name: "review-tools" }, null, 2));
    await writeFile(join(pluginSource, "skills", "plugin-review", "SKILL.md"), SKILL_MD("plugin-review"));
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1
agents = ["codex", "pi"]

[[skills]]
name = "review-tools"
source = "path:local-skills/review-tools"

[[plugins]]
name = "review-tools"
source = "path:plugins/review-tools"
`,
    );
    const scope = resolveScope("project", projectRoot);
    await runInstall({ scope });

    await runRemove({ scope, name: "review-tools" });

    const config = await loadConfig(join(projectRoot, "agents.toml"));
    expect(config.skills.find((skill) => skill.name === "review-tools")).toBeUndefined();
    expect(config.plugins.find((plugin) => plugin.name === "review-tools")).toBeUndefined();
    const lockfile = await loadLockfile(join(projectRoot, "agents.lock"));
    expect(lockfile!.skills["review-tools"]).toBeUndefined();
    expect(lockfile!.plugins["review-tools"]).toBeUndefined();
    expect(existsSync(join(projectRoot, ".agents", "skills", "review-tools"))).toBe(false);
    expect(existsSync(join(projectRoot, ".agents", "skills", "plugin-review"))).toBe(false);
    expect(existsSync(join(projectRoot, ".agents", "plugins", "review-tools"))).toBe(false);
  });

  it("removes an installed plugin even when its lock entry is missing", async () => {
    const pluginSource = join(projectRoot, "plugins", "review-tools");
    await mkdir(join(pluginSource, "skills", "review"), { recursive: true });
    await writeFile(join(pluginSource, "plugin.json"), JSON.stringify({ name: "review-tools" }, null, 2));
    await writeFile(join(pluginSource, "skills", "review", "SKILL.md"), SKILL_MD("review"));
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1
agents = ["codex", "pi"]

[[plugins]]
name = "review-tools"
source = "path:plugins/review-tools"
`,
    );
    const scope = resolveScope("project", projectRoot);
    await runInstall({ scope });

    const lockfile = await loadLockfile(join(projectRoot, "agents.lock"));
    delete lockfile!.plugins["review-tools"];
    await writeLockfile(join(projectRoot, "agents.lock"), lockfile!);
    await rm(join(projectRoot, ".agents", "plugins", "review-tools", DOTAGENTS_MANAGED_PLUGIN_MARKER), { force: true });

    await runRemove({ scope, name: "review-tools" });

    const config = await loadConfig(join(projectRoot, "agents.toml"));
    expect(config.plugins.find((plugin) => plugin.name === "review-tools")).toBeUndefined();
    expect(existsSync(join(projectRoot, ".agents", "plugins", "review-tools"))).toBe(false);
    expect(existsSync(join(projectRoot, ".agents", "skills", "review"))).toBe(false);
  });

  it("removes plugins by source", async () => {
    const pluginSource = join(projectRoot, "plugins", "review-tools");
    await mkdir(pluginSource, { recursive: true });
    await writeFile(join(pluginSource, "plugin.json"), JSON.stringify({ name: "review-tools" }, null, 2));
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1

[[plugins]]
name = "review-tools"
source = "path:plugins/review-tools"
`,
    );
    const scope = resolveScope("project", projectRoot);
    await runInstall({ scope });

    await expect(runRemovePluginSource({ scope, source: "path:plugins/review-tools" }))
      .resolves.toEqual(["review-tools"]);

    const config = await loadConfig(join(projectRoot, "agents.toml"));
    expect(config.plugins).toEqual([]);
    const lockfile = await loadLockfile(join(projectRoot, "agents.lock"));
    expect(lockfile!.plugins).toEqual({});
  });

  it("throws RemoveError for skill not in config", async () => {
    await writeFile(join(projectRoot, "agents.toml"), "version = 1\n");
    const scope = resolveScope("project", projectRoot);

    await expect(runRemove({ scope, name: "nonexistent" })).rejects.toThrow(RemoveError);
  });

  it("throws WildcardSkillRemoveError for wildcard-sourced skill", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "*"\nsource = "git:${repoDir}"\n`,
    );
    const scope = resolveScope("project", projectRoot);
    await runInstall({ scope });

    // Trying to remove "pdf" which is wildcard-sourced
    await expect(runRemove({ scope, name: "pdf" })).rejects.toThrow(WildcardSkillRemoveError);
  });

  it("does not treat skills outside wildcard path scope as wildcard-owned", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "*"\nsource = "git:${repoDir}"\n`,
    );
    const scope = resolveScope("project", projectRoot);
    await runInstall({ scope });
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "*"\nsource = "git:${repoDir}"\npath = "skills"\n`,
    );

    await expect(runRemove({ scope, name: "pdf" })).rejects.toThrow(RemoveError);
  });

  it("WildcardSkillRemoveError carries the source", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "*"\nsource = "git:${repoDir}"\n`,
    );
    const scope = resolveScope("project", projectRoot);
    await runInstall({ scope });

    try {
      await runRemove({ scope, name: "pdf" });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(WildcardSkillRemoveError);
      expect((err as WildcardSkillRemoveError).source).toBe(`git:${repoDir}`);
    }
  });

  it("removes explicit entry even when wildcard exists for same source", async () => {
    // Explicit "pdf" + wildcard from same repo
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "pdf"\nsource = "git:${repoDir}"\n\n[[skills]]\nname = "*"\nsource = "git:${repoDir}"\n`,
    );
    const scope = resolveScope("project", projectRoot);
    await runInstall({ scope });

    // Removing "pdf" should remove the explicit entry, not trigger wildcard error
    await runRemove({ scope, name: "pdf" });

    const config = await loadConfig(join(projectRoot, "agents.toml"));
    expect(config.skills.find((s) => s.name === "pdf")).toBeUndefined();
    // Wildcard entry should still exist
    expect(config.skills.some((s) => s.name === "*")).toBe(true);
  });
});

describe("runRemoveSource", () => {
  let tmpDir: string;
  let stateDir: string;
  let projectRoot: string;
  let repoDir: string;
  let otherRepoDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dotagents-remove-source-"));
    stateDir = join(tmpDir, "state");
    projectRoot = join(tmpDir, "project");
    repoDir = join(tmpDir, "repo");
    otherRepoDir = join(tmpDir, "other-repo");

    process.env["DOTAGENTS_STATE_DIR"] = stateDir;

    await mkdir(join(projectRoot, ".agents", "skills"), { recursive: true });

    // Create a local git repo with skills
    await mkdir(repoDir, { recursive: true });
    await exec("git", ["init"], { cwd: repoDir });
    await exec("git", ["config", "user.email", "test@test.com"], { cwd: repoDir });
    await exec("git", ["config", "user.name", "Test"], { cwd: repoDir });
    await exec("git", ["config", "commit.gpgsign", "false"], { cwd: repoDir });

    await mkdir(join(repoDir, "pdf"), { recursive: true });
    await writeFile(join(repoDir, "pdf", "SKILL.md"), SKILL_MD("pdf"));

    await mkdir(join(repoDir, "skills", "review"), { recursive: true });
    await writeFile(join(repoDir, "skills", "review", "SKILL.md"), SKILL_MD("review"));

    await exec("git", ["add", "."], { cwd: repoDir });
    await exec("git", ["commit", "-m", "initial"], { cwd: repoDir });

    // Create a second repo with a different skill
    await mkdir(otherRepoDir, { recursive: true });
    await exec("git", ["init"], { cwd: otherRepoDir });
    await exec("git", ["config", "user.email", "test@test.com"], { cwd: otherRepoDir });
    await exec("git", ["config", "user.name", "Test"], { cwd: otherRepoDir });
    await exec("git", ["config", "commit.gpgsign", "false"], { cwd: otherRepoDir });

    await mkdir(join(otherRepoDir, "deploy"), { recursive: true });
    await writeFile(join(otherRepoDir, "deploy", "SKILL.md"), SKILL_MD("deploy"));

    await exec("git", ["add", "."], { cwd: otherRepoDir });
    await exec("git", ["commit", "-m", "initial"], { cwd: otherRepoDir });
  });

  afterEach(async () => {
    delete process.env["DOTAGENTS_STATE_DIR"];
    await rm(tmpDir, { recursive: true });
  });

  it("removes all explicit skills from a source, keeps skills from other sources", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "pdf"\nsource = "git:${repoDir}"\n\n[[skills]]\nname = "review"\nsource = "git:${repoDir}"\n\n[[skills]]\nname = "deploy"\nsource = "git:${otherRepoDir}"\n`,
    );
    const scope = resolveScope("project", projectRoot);
    await runInstall({ scope });

    const removed = await runRemoveSource({ scope, source: `git:${repoDir}` });

    expect(removed).toEqual(["pdf", "review"]);

    const config = await loadConfig(join(projectRoot, "agents.toml"));
    expect(config.skills).toHaveLength(1);
    expect(config.skills[0]!.name).toBe("deploy");

    expect(existsSync(join(projectRoot, ".agents", "skills", "pdf"))).toBe(false);
    expect(existsSync(join(projectRoot, ".agents", "skills", "review"))).toBe(false);
    expect(existsSync(join(projectRoot, ".agents", "skills", "deploy"))).toBe(true);

    const lockfile = await loadLockfile(join(projectRoot, "agents.lock"));
    expect(lockfile!.skills["pdf"]).toBeUndefined();
    expect(lockfile!.skills["review"]).toBeUndefined();
    expect(lockfile!.skills["deploy"]).toBeDefined();
  });

  it("removes wildcard entry and all expanded skills", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "*"\nsource = "git:${repoDir}"\n\n[[skills]]\nname = "deploy"\nsource = "git:${otherRepoDir}"\n`,
    );
    const scope = resolveScope("project", projectRoot);
    await runInstall({ scope });

    const removed = await runRemoveSource({ scope, source: `git:${repoDir}` });

    expect(removed).toEqual(["pdf", "review"]);

    const config = await loadConfig(join(projectRoot, "agents.toml"));
    expect(config.skills).toHaveLength(1);
    expect(config.skills[0]!.name).toBe("deploy");

    expect(existsSync(join(projectRoot, ".agents", "skills", "pdf"))).toBe(false);
    expect(existsSync(join(projectRoot, ".agents", "skills", "review"))).toBe(false);
    expect(existsSync(join(projectRoot, ".agents", "skills", "deploy"))).toBe(true);
  });

  it("throws RemoveError when no skills match the source", async () => {
    await writeFile(join(projectRoot, "agents.toml"), "version = 1\n");
    const scope = resolveScope("project", projectRoot);

    await expect(
      runRemoveSource({ scope, source: `git:${repoDir}` }),
    ).rejects.toThrow(RemoveError);
  });

  it("collectSkillsFromSource normalizes different URL forms", async () => {
    // Use HTTPS URL form in config but query with shorthand-like source
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "pdf"\nsource = "https://github.com/testowner/testrepo"\n`,
    );
    const scope = resolveScope("project", projectRoot);

    // Install won't work with fake GitHub URL, but config is enough for collectSkillsFromSource
    // since it only reads config + lockfile
    const names = await collectSkillsFromSource(scope, "testowner/testrepo");
    expect(names).toEqual(["pdf"]);
  });
});
