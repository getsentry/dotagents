import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
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
import { AGENT_PLUGIN_SCHEMA } from "../../plugins/schema.js";

const SKILL_MD = (name: string) => `---
name: ${name}
description: Test skill ${name}
---
`;

function componentMarkerContent(linkPath: string, targetPath: string): string {
  return `managedBy=dotagents\ntarget=${JSON.stringify(relative(dirname(linkPath), targetPath))}\n`;
}

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

  it("removes portable OpenCode MCP without touching unrelated config", async () => {
    const pluginSource = join(projectRoot, "plugins", "review-tools");
    await mkdir(pluginSource, { recursive: true });
    await writeFile(join(pluginSource, "plugin.json"), JSON.stringify({
      $schema: AGENT_PLUGIN_SCHEMA,
      name: "review-tools",
      version: "1.0.0",
    }));
    await writeFile(join(pluginSource, "mcp.json"), JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: {
        review: {
          type: "streamable-http",
          url: "https://example.com/review-mcp",
        },
      },
    }));
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1
agents = ["opencode"]

[[plugins]]
name = "review-tools"
source = "path:plugins/review-tools"
`,
    );
    const openCodePath = join(projectRoot, ".opencode", "opencode.jsonc");
    await mkdir(dirname(openCodePath), { recursive: true });
    await writeFile(openCodePath, JSON.stringify({
      mcp: {
        manual: { type: "remote", url: "https://example.com/manual" },
      },
    }));
    const scope = resolveScope("project", projectRoot);
    await runInstall({ scope });

    expect(JSON.parse(await readFile(openCodePath, "utf-8")).mcp)
      .toHaveProperty("plugin.review-tools.review");
    expect(existsSync(join(projectRoot, ".agents", "plugin-mcp", "opencode.json"))).toBe(true);

    await runRemove({ scope, name: "review-tools" });

    expect(JSON.parse(await readFile(openCodePath, "utf-8")).mcp).toEqual({
      manual: { type: "remote", url: "https://example.com/manual" },
    });
    expect(existsSync(join(projectRoot, ".agents", "plugin-mcp", "opencode.json"))).toBe(false);
  });

  it("preserves runtime outputs when another installed plugin is broken", async () => {
    for (const name of ["alpha", "beta"]) {
      const pluginSource = join(projectRoot, "plugins", name);
      await mkdir(join(pluginSource, "skills", name), { recursive: true });
      await writeFile(join(pluginSource, "plugin.json"), JSON.stringify({ name }, null, 2));
      await writeFile(join(pluginSource, "skills", name, "SKILL.md"), SKILL_MD(name));
    }
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1
agents = ["opencode", "pi"]

[[plugins]]
name = "alpha"
source = "path:plugins/alpha"

[[plugins]]
name = "beta"
source = "path:plugins/beta"
`,
    );
    const scope = resolveScope("project", projectRoot);
    await runInstall({ scope });
    const openCodeLink = join(projectRoot, ".opencode", "skills", "beta");
    const piLink = join(projectRoot, ".agents", "skills", "beta");
    await writeFile(join(projectRoot, ".agents", "plugins", "beta", "plugin.json"), "{broken");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await runRemove({ scope, name: "alpha" });

    expect(existsSync(openCodeLink)).toBe(true);
    expect(existsSync(piLink)).toBe(true);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Plugin runtime cleanup was skipped"));
    log.mockRestore();
  });

  it("preserves a same-project plugin source when its lock entry is stale", async () => {
    const pluginDir = join(projectRoot, ".agents", "plugins", "local-tools");
    const skillDir = join(pluginDir, "skills", "local-review");
    const openCodeLink = join(projectRoot, ".opencode", "skills", "local-review");
    const piLink = join(projectRoot, ".agents", "skills", "local-review");
    await mkdir(skillDir, { recursive: true });
    await mkdir(join(projectRoot, ".opencode", "skills"), { recursive: true });
    await mkdir(join(projectRoot, ".agents", "skills"), { recursive: true });
    await writeFile(join(pluginDir, "plugin.json"), JSON.stringify({ name: "local-tools" }, null, 2));
    await writeFile(join(skillDir, "SKILL.md"), SKILL_MD("local-review"));
    await symlink(relative(dirname(openCodeLink), skillDir), openCodeLink);
    await symlink(relative(dirname(piLink), skillDir), piLink);
    await mkdir(join(dirname(openCodeLink), ".dotagents-managed"), { recursive: true });
    await mkdir(join(dirname(piLink), ".dotagents-managed"), { recursive: true });
    await writeFile(
      join(dirname(openCodeLink), ".dotagents-managed", "local-review"),
      componentMarkerContent(openCodeLink, skillDir),
    );
    await writeFile(
      join(dirname(piLink), ".dotagents-managed", "local-review"),
      componentMarkerContent(piLink, skillDir),
    );
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1
agents = ["opencode", "pi"]

[[plugins]]
name = "local-tools"
source = "path:."
`,
    );
    await writeLockfile(join(projectRoot, "agents.lock"), {
      version: 1,
      skills: {},
      plugins: {
        "local-tools": {
          source: "getsentry/old-plugin-source",
        },
      },
    });

    const scope = resolveScope("project", projectRoot);
    await runRemove({ scope, name: "local-tools" });

    expect(existsSync(pluginDir)).toBe(true);
    expect(JSON.parse(await readFile(join(pluginDir, "plugin.json"), "utf-8"))).toEqual({
      name: "local-tools",
    });
    expect(existsSync(openCodeLink)).toBe(false);
    expect(existsSync(piLink)).toBe(false);
    expect((await loadConfig(join(projectRoot, "agents.toml"))).plugins).toEqual([]);
    expect((await loadLockfile(join(projectRoot, "agents.lock")))!.plugins).toEqual({});
  });

  it("rejects an ambiguous name shared by an explicit skill and plugin", async () => {
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

    await expect(runRemove({ scope, name: "review-tools" }))
      .rejects.toThrow("matches both a skill and a plugin");

    const config = await loadConfig(join(projectRoot, "agents.toml"));
    expect(config.skills.find((skill) => skill.name === "review-tools")).toBeDefined();
    expect(config.plugins.find((plugin) => plugin.name === "review-tools")).toBeDefined();
    const lockfile = await loadLockfile(join(projectRoot, "agents.lock"));
    expect(lockfile!.skills["review-tools"]).toBeDefined();
    expect(lockfile!.plugins["review-tools"]).toBeDefined();
    expect(existsSync(join(projectRoot, ".agents", "skills", "review-tools"))).toBe(true);
    expect(existsSync(join(projectRoot, ".agents", "skills", "plugin-review"))).toBe(true);
    expect(existsSync(join(projectRoot, ".agents", "plugins", "review-tools"))).toBe(true);
  });

  it("rejects an ambiguous name shared by a wildcard skill and plugin", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1

[[skills]]
name = "*"
source = "org/skills"

[[plugins]]
name = "pdf"
source = "path:plugins/pdf"
`,
    );
    await writeLockfile(join(projectRoot, "agents.lock"), {
      version: 1,
      skills: {
        pdf: {
          source: "org/skills",
          resolved_url: "https://github.com/org/skills.git",
          resolved_path: "pdf",
        },
      },
      plugins: { pdf: { source: "path:plugins/pdf" } },
    });

    const scope = resolveScope("project", projectRoot);
    await expect(runRemove({ scope, name: "pdf" }))
      .rejects.toThrow("matches both a wildcard-provided skill and a plugin");

    const config = await loadConfig(join(projectRoot, "agents.toml"));
    expect(config.skills).toHaveLength(1);
    expect(config.plugins).toHaveLength(1);
    const lockfile = await loadLockfile(join(projectRoot, "agents.lock"));
    expect(lockfile!.skills["pdf"]).toBeDefined();
    expect(lockfile!.plugins["pdf"]).toBeDefined();
  });

  it("preserves an installed plugin without an ownership marker", async () => {
    const pluginSource = join(projectRoot, "plugins", "review-tools");
    await mkdir(join(pluginSource, "skills", "review"), { recursive: true });
    await mkdir(join(pluginSource, ".codex-plugin"), { recursive: true });
    await writeFile(join(pluginSource, "plugin.json"), JSON.stringify({
      $schema: AGENT_PLUGIN_SCHEMA,
      name: "review-tools",
    }, null, 2));
    const authoredBytes = '{ "name": "review-tools", "metadata": {"managedBy": "dotagents"}, "x-authored": true }\n';
    await writeFile(join(pluginSource, ".codex-plugin", "plugin.json"), authoredBytes);
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
    expect(existsSync(join(projectRoot, ".agents", "plugins", "review-tools"))).toBe(true);
    expect(await readFile(
      join(projectRoot, ".agents", "plugins", "review-tools", ".codex-plugin", "plugin.json"),
      "utf-8",
    )).toBe(authoredBytes);
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

  it("does not treat malformed lockfile plugin names as projection roots when removing by source", async () => {
    const outsideSkillDir = join(projectRoot, "outside", "keep");
    const linkDir = join(projectRoot, ".opencode", "skills");
    const linkPath = join(linkDir, "keep");
    await mkdir(outsideSkillDir, { recursive: true });
    await mkdir(linkDir, { recursive: true });
    await writeFile(join(outsideSkillDir, "SKILL.md"), SKILL_MD("keep"));
    await symlink(relative(linkDir, outsideSkillDir), linkPath);
    await writeFile(join(projectRoot, "agents.toml"), `version = 1\nagents = ["opencode"]\n`);
    await writeLockfile(join(projectRoot, "agents.lock"), {
      version: 1,
      skills: {},
      plugins: {
        "../../outside": { source: "org/old-tools" },
      },
    });

    const scope = resolveScope("project", projectRoot);
    await expect(runRemovePluginSource({ scope, source: "org/old-tools" }))
      .resolves.toEqual(["../../outside"]);

    expect(existsSync(linkPath)).toBe(true);
    expect(await readFile(join(outsideSkillDir, "SKILL.md"), "utf-8")).toBe(SKILL_MD("keep"));
    expect((await loadLockfile(join(projectRoot, "agents.lock")))!.plugins).toEqual({});
  });

  it("does not delete outside the skills directory for malformed lockfile names", async () => {
    const hooksDir = join(projectRoot, ".agents", "hooks");
    await mkdir(hooksDir, { recursive: true });
    await writeFile(join(hooksDir, "keep.sh"), "echo keep\n");
    await writeFile(join(projectRoot, "agents.toml"), "version = 1\n");
    await writeLockfile(join(projectRoot, "agents.lock"), {
      version: 1,
      skills: {
        "../hooks": { source: "path:old-skills" },
      },
    });

    const scope = resolveScope("project", projectRoot);
    await expect(runRemoveSource({ scope, source: "path:old-skills" }))
      .resolves.toEqual(["../hooks"]);

    expect(await readFile(join(hooksDir, "keep.sh"), "utf-8")).toBe("echo keep\n");
    expect((await loadLockfile(join(projectRoot, "agents.lock")))!.skills).toEqual({});
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
      if (!(err instanceof WildcardSkillRemoveError)) {throw err;}
      expect(err.source).toBe(`git:${repoDir}`);
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
