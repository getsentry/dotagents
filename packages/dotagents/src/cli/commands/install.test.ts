import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, rm, lstat, access, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runInstall as runInstallCommand, InstallError, type InstallOptions, type InstallResult } from "./install.js";
import { runSync } from "./sync.js";
import { exec } from "@sentry/dotagents-lib";
import { loadLockfile } from "../../lockfile/loader.js";
import { writeLockfile } from "../../lockfile/writer.js";
import type { Lockfile } from "../../lockfile/schema.js";
import { resolveScope } from "../../scope.js";
import { DOTAGENTS_SUBAGENT_MARKER } from "../../subagents/format.js";

const SKILL_MD = (name: string) => `---
name: ${name}
description: Test skill ${name}
---

# ${name}
`;

const SUBAGENT_MD = (name: string) => `---
name: ${name}
description: Review code for correctness.
---

Review the current diff.
`;

async function initTestGitRepo(repoDir: string): Promise<void> {
  await exec("git", ["init"], { cwd: repoDir });
  await exec("git", ["config", "user.email", "test@test.com"], { cwd: repoDir });
  await exec("git", ["config", "user.name", "Test"], { cwd: repoDir });
  await exec("git", ["config", "commit.gpgsign", "false"], { cwd: repoDir });
}

describe("runInstall", () => {
  let tmpDir: string;
  let stateDir: string;
  let projectRoot: string;
  let repoDir: string;
  let repoInitialized: boolean;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dotagents-install-"));
    stateDir = join(tmpDir, "state");
    projectRoot = join(tmpDir, "project");
    repoDir = join(tmpDir, "repo");
    repoInitialized = false;

    process.env["DOTAGENTS_STATE_DIR"] = stateDir;

    // Set up project
    await mkdir(join(projectRoot, ".agents", "skills"), { recursive: true });

  });

  async function ensureGitRepo(): Promise<void> {
    if (repoInitialized) {return;}

    await mkdir(repoDir, { recursive: true });
    await initTestGitRepo(repoDir);

    await mkdir(join(repoDir, "pdf"), { recursive: true });
    await writeFile(join(repoDir, "pdf", "SKILL.md"), SKILL_MD("pdf"));
    await writeFile(join(repoDir, "pdf", "prompt.md"), "Process PDFs");

    await mkdir(join(repoDir, "skills", "review"), { recursive: true });
    await writeFile(join(repoDir, "skills", "review", "SKILL.md"), SKILL_MD("review"));

    await exec("git", ["add", "."], { cwd: repoDir });
    await exec("git", ["commit", "-m", "initial"], { cwd: repoDir });
    repoInitialized = true;
  }

  async function runInstall(opts: InstallOptions): Promise<InstallResult> {
    const config = await readFile(opts.scope.configPath, "utf-8").catch(() => "");
    if (config.includes(`git:${repoDir}`)) {
      await ensureGitRepo();
    }
    return runInstallCommand(opts);
  }

  afterEach(async () => {
    delete process.env["DOTAGENTS_STATE_DIR"];
    await rm(tmpDir, { recursive: true });
  });

  it("installs a skill from a git source", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "pdf"\nsource = "git:${repoDir}"\n`,
    );

    const scope = resolveScope("project", projectRoot);
    const result = await runInstall({ scope });
    expect(result.installed).toContain("pdf");

    // Skill directory should exist
    expect(existsSync(join(projectRoot, ".agents", "skills", "pdf", "SKILL.md"))).toBe(true);
    expect(existsSync(join(projectRoot, ".agents", "skills", "pdf", "prompt.md"))).toBe(true);
  });

  it("creates agents.lock after install", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "pdf"\nsource = "git:${repoDir}"\n`,
    );

    const scope = resolveScope("project", projectRoot);
    await runInstall({ scope });

    const lockfile = await loadLockfile(join(projectRoot, "agents.lock"));
    expect(lockfile).not.toBeNull();
    expect(lockfile!.skills["pdf"]).toBeDefined();
    expect(lockfile!.skills["pdf"]!.source).toBeDefined();
    // resolved_commit is informational, should be present for git skills
    expect("resolved_commit" in lockfile!.skills["pdf"]!).toBe(true);
    expect("integrity" in lockfile!.skills["pdf"]!).toBe(false);
  });

  it("installs a local plugin and writes deterministic runtime artifacts", async () => {
    const sourceDir = join(projectRoot, "plugin-source", "review-tools");
    await mkdir(join(sourceDir, "skills", "review"), { recursive: true });
    await mkdir(join(sourceDir, "commands"), { recursive: true });
    await writeFile(
      join(sourceDir, "plugin.json"),
      JSON.stringify({
        name: "review-tools",
        version: "1.0.0",
        description: "Review workflow helpers",
        category: "Coding",
        author: { name: "Sentry" },
        "x-extra": { kept: true },
      }, null, 2),
    );
    await writeFile(join(sourceDir, "skills", "review", "SKILL.md"), SKILL_MD("review"));
    await writeFile(join(sourceDir, "commands", "review.md"), "Review command");
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1
agents = ["codex", "claude", "cursor"]

[[plugins]]
name = "review-tools"
source = "path:plugin-source/review-tools"
`,
    );

    const scope = resolveScope("project", projectRoot);
    await runInstall({ scope });

    expect(existsSync(join(projectRoot, ".agents", "plugins", "review-tools", "plugin.json"))).toBe(true);
    expect(existsSync(join(projectRoot, ".agents", "plugins", "review-tools", "skills", "review", "SKILL.md"))).toBe(true);

    const lockfile = await loadLockfile(join(projectRoot, "agents.lock"));
    expect(lockfile!.plugins["review-tools"]).toEqual({
      source: "path:plugin-source/review-tools",
    });

    expect(await readFile(join(projectRoot, ".agents", "plugins", "marketplace.json"), "utf-8")).toBe(`{
  "interface": {
    "displayName": "Dotagents Plugins"
  },
  "metadata": {
    "managedBy": "dotagents"
  },
  "name": "dotagents",
  "owner": {
    "name": "dotagents"
  },
  "plugins": [
    {
      "category": "Coding",
      "description": "Review workflow helpers",
      "name": "review-tools",
      "policy": {
        "authentication": "ON_INSTALL",
        "installation": "AVAILABLE"
      },
      "source": {
        "path": ".agents/plugins/review-tools",
        "source": "local"
      },
      "version": "1.0.0"
    }
  ]
}
`);
    expect(await readFile(join(projectRoot, ".claude-plugin", "marketplace.json"), "utf-8")).toBe(`{
  "metadata": {
    "managedBy": "dotagents"
  },
  "name": "dotagents",
  "owner": {
    "name": "dotagents"
  },
  "plugins": [
    {
      "description": "Review workflow helpers",
      "name": "review-tools",
      "source": ".agents/plugins/review-tools",
      "version": "1.0.0"
    }
  ]
}
`);
    expect(await readFile(join(projectRoot, ".cursor-plugin", "marketplace.json"), "utf-8")).toBe(await readFile(join(projectRoot, ".claude-plugin", "marketplace.json"), "utf-8"));

    const codexManifest = JSON.parse(await readFile(join(projectRoot, ".agents", "plugins", "review-tools", ".codex-plugin", "plugin.json"), "utf-8")) as Record<string, unknown>;
    expect(codexManifest["name"]).toBe("review-tools");
    expect(codexManifest["skills"]).toBe("./skills");
    expect(codexManifest["commands"]).toBe("./commands");
    expect(codexManifest["x-extra"]).toEqual({ kept: true });

    const agentsGitignore = await readFile(join(projectRoot, ".agents", ".gitignore"), "utf-8");
    expect(agentsGitignore).toContain("/plugins/review-tools/");
  });

  it("keeps plugin lock entries when runtime projection fails after installing the bundle", async () => {
    const sourceDir = join(projectRoot, "plugin-source", "review-tools");
    await mkdir(join(sourceDir, "skills", "review"), { recursive: true });
    await writeFile(
      join(sourceDir, "plugin.json"),
      JSON.stringify({ name: "review-tools", description: "Review workflow helpers" }, null, 2),
    );
    await writeFile(join(sourceDir, "skills", "review", "SKILL.md"), SKILL_MD("review"));
    await writeFile(join(sourceDir, ".codex-plugin"), "not a directory\n", "utf-8");
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1
agents = ["codex"]

[[plugins]]
name = "review-tools"
source = "path:plugin-source/review-tools"
`,
    );

    const scope = resolveScope("project", projectRoot);
    await expect(runInstall({ scope })).rejects.toThrow();

    const lockfile = await loadLockfile(join(projectRoot, "agents.lock"));
    expect(lockfile!.plugins["review-tools"]).toEqual({
      source: "path:plugin-source/review-tools",
    });
    expect(existsSync(join(projectRoot, ".agents", "plugins", "review-tools", "plugin.json"))).toBe(true);
  });

  it("rejects same-project plugins that would install onto themselves", async () => {
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

    const scope = resolveScope("project", projectRoot);
    await expect(runInstall({ scope })).rejects.toThrow(/Same-project plugins cannot be installed into the same project/);
    expect(existsSync(pluginDir)).toBe(true);
    expect(existsSync(join(projectRoot, ".agents", "plugins", "marketplace.json"))).toBe(false);
  });

  it("rejects same-project plugin sources nested under their install destination", async () => {
    const pluginDir = join(projectRoot, ".agents", "plugins", "local-tools");
    const sourceDir = join(pluginDir, "source");
    await mkdir(join(sourceDir, "skills", "review"), { recursive: true });
    await writeFile(
      join(sourceDir, "plugin.json"),
      JSON.stringify({
        name: "local-tools",
        description: "Local plugin",
      }, null, 2),
    );
    await writeFile(join(sourceDir, "skills", "review", "SKILL.md"), SKILL_MD("review"));
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1
agents = ["codex"]

[[plugins]]
name = "local-tools"
source = "path:./.agents/plugins/local-tools/source"
`,
    );

    const scope = resolveScope("project", projectRoot);
    await expect(runInstall({ scope })).rejects.toThrow(/Same-project plugins cannot be installed into the same project/);
    expect(existsSync(sourceDir)).toBe(true);
  });

  it("prefers canonical plugin directories before marketplace entries", async () => {
    const sourceRoot = join(projectRoot, "plugin-source");
    const canonicalDir = join(sourceRoot, ".agents", "plugins", "review-tools");
    const marketplaceDir = join(sourceRoot, "plugins", "review-tools-alt");
    await mkdir(canonicalDir, { recursive: true });
    await mkdir(marketplaceDir, { recursive: true });
    await writeFile(
      join(canonicalDir, "plugin.json"),
      JSON.stringify({ name: "review-tools", description: "Canonical plugin" }, null, 2),
    );
    await writeFile(
      join(marketplaceDir, "plugin.json"),
      JSON.stringify({ name: "review-tools", description: "Marketplace plugin" }, null, 2),
    );
    await writeFile(
      join(sourceRoot, "marketplace.json"),
      JSON.stringify({
        name: "source",
        plugins: [
          {
            name: "review-tools",
            source: {
              source: "local",
              path: "plugins/review-tools-alt",
            },
          },
        ],
      }, null, 2),
    );
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1
agents = ["codex"]

[[plugins]]
name = "review-tools"
source = "path:plugin-source"
`,
    );

    const scope = resolveScope("project", projectRoot);
    await runInstall({ scope });

    const installed = JSON.parse(
      await readFile(join(projectRoot, ".agents", "plugins", "review-tools", "plugin.json"), "utf-8"),
    ) as Record<string, unknown>;
    expect(installed["description"]).toBe("Canonical plugin");
  });

  it("generates plugin runtime outputs in frozen mode from installed bundles", async () => {
    const pluginDir = join(projectRoot, ".agents", "plugins", "review-tools");
    await mkdir(join(pluginDir, "skills", "review"), { recursive: true });
    await writeFile(
      join(pluginDir, "plugin.json"),
      JSON.stringify({
        name: "review-tools",
        description: "Review workflow helpers",
      }, null, 2),
    );
    await writeFile(join(pluginDir, "skills", "review", "SKILL.md"), SKILL_MD("review"));
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1
agents = ["codex"]

[[plugins]]
name = "review-tools"
source = "path:external-source"
`,
    );
    await writeLockfile(join(projectRoot, "agents.lock"), {
      version: 1,
      skills: {},
      subagents: {},
      plugins: {
        "review-tools": {
          source: "path:external-source",
        },
      },
    });

    const scope = resolveScope("project", projectRoot);
    await runInstall({ scope, frozen: true });

    expect(existsSync(join(projectRoot, ".agents", "plugins", "marketplace.json"))).toBe(true);
    expect(existsSync(join(projectRoot, ".agents", "plugins", "review-tools", ".codex-plugin", "plugin.json"))).toBe(true);
  });

  it("installs multiple skills", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "pdf"\nsource = "git:${repoDir}"\n\n[[skills]]\nname = "review"\nsource = "git:${repoDir}"\n`,
    );

    const scope = resolveScope("project", projectRoot);
    const result = await runInstall({ scope });
    expect(result.installed).toHaveLength(2);
    expect(existsSync(join(projectRoot, ".agents", "skills", "pdf", "SKILL.md"))).toBe(true);
    expect(existsSync(join(projectRoot, ".agents", "skills", "review", "SKILL.md"))).toBe(true);
  });

  it("regenerates .agents/.gitignore", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "pdf"\nsource = "git:${repoDir}"\n`,
    );

    const scope = resolveScope("project", projectRoot);
    await runInstall({ scope });

    const gitignore = await readFile(
      join(projectRoot, ".agents", ".gitignore"),
      "utf-8",
    );
    expect(gitignore).toContain("/skills/pdf/");
  });

  it("handles empty skills list", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      "version = 1\n",
    );

    const scope = resolveScope("project", projectRoot);
    const result = await runInstall({ scope });
    expect(result.installed).toHaveLength(0);
  });

  it("writes MCP configs even with no skills", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\nagents = ["claude"]\n\n[[mcp]]\nname = "github"\ncommand = "npx"\nargs = ["-y", "@mcp/server-github"]\n`,
    );

    const scope = resolveScope("project", projectRoot);
    await runInstall({ scope });

    const mcp = JSON.parse(await readFile(join(projectRoot, ".mcp.json"), "utf-8"));
    expect(mcp.mcpServers.github).toBeDefined();

    // Agent symlinks should also be created
    const stat = await lstat(join(projectRoot, ".claude", "skills"));
    expect(stat.isSymbolicLink()).toBe(true);
  });

  it("fails with --frozen when no lockfile exists", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "pdf"\nsource = "git:${repoDir}"\n`,
    );

    const scope = resolveScope("project", projectRoot);
    await expect(
      runInstall({ scope, frozen: true }),
    ).rejects.toThrow(InstallError);
  });

  it("frozen mode passes when lockfile matches", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "pdf"\nsource = "git:${repoDir}"\n`,
    );

    const scope = resolveScope("project", projectRoot);

    // First install to create lockfile
    await runInstall({ scope });

    // Second install with --frozen
    const result = await runInstall({ scope, frozen: true });
    expect(result.installed).toContain("pdf");
  });

  it("creates agent-specific symlinks (cursor shares .claude)", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\nagents = ["claude", "cursor"]\n\n[[skills]]\nname = "pdf"\nsource = "git:${repoDir}"\n`,
    );

    const scope = resolveScope("project", projectRoot);
    await runInstall({ scope });

    const claudeStat = await lstat(join(projectRoot, ".claude", "skills"));
    expect(claudeStat.isSymbolicLink()).toBe(true);
    // Cursor shares .claude/skills — no .cursor/skills symlink created
    await expect(access(join(projectRoot, ".cursor", "skills"))).rejects.toThrow();
  });

  it("writes MCP configs for declared agents", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\nagents = ["claude"]\n\n[[skills]]\nname = "pdf"\nsource = "git:${repoDir}"\n\n[[mcp]]\nname = "github"\ncommand = "npx"\nargs = ["-y", "@mcp/server-github"]\n`,
    );

    const scope = resolveScope("project", projectRoot);
    await runInstall({ scope });

    const mcp = JSON.parse(await readFile(join(projectRoot, ".mcp.json"), "utf-8"));
    expect(mcp.mcpServers.github).toBeDefined();
    expect(mcp.mcpServers.github.command).toBe("npx");
  });

  it("writes hook configs for declared agents", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\nagents = ["claude"]\n\n[[hooks]]\nevent = "PreToolUse"\nmatcher = "Bash"\ncommand = ".agents/hooks/block-rm.sh"\n`,
    );

    const scope = resolveScope("project", projectRoot);
    const result = await runInstall({ scope });
    expect(result.hookWarnings).toHaveLength(0);

    const settings = JSON.parse(await readFile(join(projectRoot, ".claude", "settings.json"), "utf-8"));
    expect(settings.hooks.PreToolUse).toEqual([
      { matcher: "Bash", hooks: [{ type: "command", command: ".agents/hooks/block-rm.sh" }] },
    ]);
  });

  it("returns hook warnings for unsupported agents", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\nagents = ["codex"]\n\n[[hooks]]\nevent = "Stop"\ncommand = "check.sh"\n`,
    );

    const scope = resolveScope("project", projectRoot);
    const result = await runInstall({ scope });
    expect(result.hookWarnings).toHaveLength(1);
    expect(result.hookWarnings[0]!.agent).toBe("codex");
  });

  it("writes subagent configs for declared agents", async () => {
    const sourceDir = join(projectRoot, "agents");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "code-reviewer.md"), SUBAGENT_MD("code-reviewer"));

    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1
agents = ["claude", "codex", "opencode"]

[[subagents]]
name = "code-reviewer"
source = "path:agents"
path = "code-reviewer.md"
`,
    );

    const scope = resolveScope("project", projectRoot);
    const result = await runInstall({ scope });
    expect(result.subagentWarnings).toHaveLength(0);

    const claude = await readFile(join(projectRoot, ".claude", "agents", "code-reviewer.md"), "utf-8");
    expect(claude).toContain('description: "Review code for correctness."');

    const codex = await readFile(join(projectRoot, ".codex", "agents", "code-reviewer.toml"), "utf-8");
    expect(codex).toContain('developer_instructions = "Review the current diff."');
    expect(await readFile(join(projectRoot, ".agents", "agents", "code-reviewer.md"), "utf-8")).toContain(DOTAGENTS_SUBAGENT_MARKER);

    const opencode = await readFile(join(projectRoot, ".opencode", "agents", "code-reviewer.md"), "utf-8");
    expect(opencode).toContain('mode: "subagent"');

    const lockfile = await loadLockfile(join(projectRoot, "agents.lock"));
    expect(lockfile!.subagents["code-reviewer"]?.source).toBe("path:agents");
  });

  it("reports unmanaged installed subagent files as install errors", async () => {
    const sourceDir = join(projectRoot, "agents");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "code-reviewer.md"), SUBAGENT_MD("code-reviewer"));

    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1
[[subagents]]
name = "code-reviewer"
source = "path:agents"
path = "code-reviewer.md"
`,
    );

    const installedDir = join(projectRoot, ".agents", "agents");
    await mkdir(installedDir, { recursive: true });
    const installedPath = join(installedDir, "code-reviewer.md");
    await writeFile(installedPath, "hand-written subagent\n", "utf-8");

    let error: unknown;
    try {
      await runInstall({ scope: resolveScope("project", projectRoot) });
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(InstallError);
    expect((error as Error).message).toContain(
      "Subagent file exists and is not managed by dotagents",
    );
    expect(await readFile(installedPath, "utf-8")).toBe("hand-written subagent\n");
  });

  it("frozen mode fails when a subagent is missing from the lockfile", async () => {
    const scope = resolveScope("project", projectRoot);
    await writeLockfile(join(projectRoot, "agents.lock"), {
      version: 1,
      skills: {},
      subagents: {},
    });

    const sourceDir = join(projectRoot, "agents");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "code-reviewer.md"), SUBAGENT_MD("code-reviewer"));

    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1
[[subagents]]
name = "code-reviewer"
source = "path:agents"
path = "code-reviewer.md"
`,
    );

    await expect(runInstall({ scope, frozen: true })).rejects.toThrow(
      '--frozen: subagent "code-reviewer" is in agents.toml but missing from agents.lock.',
    );
  });

  it("frozen mode passes when subagent lockfile entries match", async () => {
    const sourceDir = join(projectRoot, "agents");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "code-reviewer.md"), SUBAGENT_MD("code-reviewer"));

    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1
[[subagents]]
name = "code-reviewer"
source = "path:agents"
path = "code-reviewer.md"
`,
    );

    const scope = resolveScope("project", projectRoot);
    await runInstall({ scope });

    await rm(sourceDir, { recursive: true });

    const result = await runInstall({ scope, frozen: true });
    expect(result.subagentWarnings).toEqual([]);
  });

  it("clears removed skills from the lockfile when installing subagents", async () => {
    const scope = resolveScope("project", projectRoot);
    const skillDir = join(projectRoot, ".agents", "skills", "pdf");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), SKILL_MD("pdf"));
    await writeLockfile(join(projectRoot, "agents.lock"), {
      version: 1,
      skills: {
        pdf: {
          source: "git:https://github.com/example/repo.git",
          resolved_url: "https://github.com/example/repo.git",
          resolved_path: "pdf",
          resolved_commit: "abc123",
        },
      },
    });

    const sourceDir = join(projectRoot, "agents");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "code-reviewer.md"), SUBAGENT_MD("code-reviewer"));

    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1
[[subagents]]
name = "code-reviewer"
source = "path:agents"
path = "code-reviewer.md"
`,
    );

    await runInstall({ scope });

    const lockfile = await loadLockfile(join(projectRoot, "agents.lock"));
    expect(lockfile!.skills).toEqual({});
    expect(lockfile!.subagents["code-reviewer"]?.source).toBe("path:agents");
    expect(existsSync(skillDir)).toBe(false);

    const syncResult = await runSync({ scope });
    expect(syncResult.adopted).toEqual([]);
  });

  it("does not update the lockfile when installed subagent writes fail", async () => {
    const skillSourceDir = join(projectRoot, "local-skills", "pdf");
    await mkdir(skillSourceDir, { recursive: true });
    await writeFile(join(skillSourceDir, "SKILL.md"), SKILL_MD("pdf"));

    const sourceDir = join(projectRoot, "agents");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "code-reviewer.md"), SUBAGENT_MD("code-reviewer"));

    await mkdir(join(projectRoot, ".agents", "agents"), { recursive: true });
    await writeFile(
      join(projectRoot, ".agents", "agents", "code-reviewer.md"),
      "hand-written subagent\n",
      "utf-8",
    );
    const originalLockfile: Lockfile = {
      version: 1,
      skills: {},
      subagents: {
        "code-reviewer": {
          source: "git:https://github.com/example/agents.git",
          resolved_url: "https://github.com/example/agents.git",
          resolved_path: "agents/code-reviewer.md",
          resolved_commit: "abc123",
        },
        "old-reviewer": {
          source: "path:old-agents",
        },
      },
      plugins: {},
    };
    await writeLockfile(join(projectRoot, "agents.lock"), originalLockfile);

    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1
[[skills]]
name = "pdf"
source = "path:local-skills/pdf"

[[subagents]]
name = "code-reviewer"
source = "path:agents"
path = "code-reviewer.md"
`,
    );

    const scope = resolveScope("project", projectRoot);

    await expect(runInstall({ scope })).rejects.toThrow(
      /Subagent file exists and is not managed by dotagents/,
    );

    const lockfile = await loadLockfile(join(projectRoot, "agents.lock"));
    expect(lockfile).toEqual(originalLockfile);
    expect(existsSync(join(projectRoot, ".agents", "skills", "pdf", "SKILL.md"))).toBe(true);
  });

  it("does not write the lockfile when stale subagent pruning fails", async () => {
    const sourceDir = join(projectRoot, "agents");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "code-reviewer.md"), SUBAGENT_MD("code-reviewer"));

    const installedDir = join(projectRoot, ".agents", "agents");
    await mkdir(installedDir, { recursive: true });
    const stalePath = join(installedDir, "old-reviewer.md");
    await writeFile(
      stalePath,
      `---
# ${DOTAGENTS_SUBAGENT_MARKER}
name: old-reviewer
description: Review old code.
---

Review old code.
`,
      "utf-8",
    );
    await chmod(stalePath, 0o000);

    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1
[[subagents]]
name = "code-reviewer"
source = "path:agents"
path = "code-reviewer.md"
`,
    );

    const scope = resolveScope("project", projectRoot);
    try {
      await expect(runInstall({ scope })).rejects.toThrow();
    } finally {
      await chmod(stalePath, 0o600).catch(() => {});
    }

    expect(await loadLockfile(join(projectRoot, "agents.lock"))).toBeNull();
    expect(existsSync(join(installedDir, "code-reviewer.md"))).toBe(true);
  });

  it("keeps lock entries when runtime subagent writes fail", async () => {
    const skillSourceDir = join(projectRoot, "local-skills", "pdf");
    await mkdir(skillSourceDir, { recursive: true });
    await writeFile(join(skillSourceDir, "SKILL.md"), SKILL_MD("pdf"));

    const sourceDir = join(projectRoot, "agents");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "code-reviewer.md"), SUBAGENT_MD("code-reviewer"));

    await writeLockfile(join(projectRoot, "agents.lock"), {
      version: 1,
      skills: {},
      subagents: {
        "code-reviewer": {
          source: "git:https://github.com/example/agents.git",
          resolved_url: "https://github.com/example/agents.git",
          resolved_path: "agents/code-reviewer.md",
          resolved_commit: "abc123",
        },
      },
    });

    await mkdir(join(projectRoot, ".claude"), { recursive: true });
    await writeFile(join(projectRoot, ".claude", "agents"), "not a directory\n");

    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1
agents = ["claude"]

[[skills]]
name = "pdf"
source = "path:local-skills/pdf"

[[subagents]]
name = "code-reviewer"
source = "path:agents"
path = "code-reviewer.md"
`,
    );

    const scope = resolveScope("project", projectRoot);
    await expect(runInstall({ scope })).rejects.toThrow();

    const lockfile = await loadLockfile(join(projectRoot, "agents.lock"));
    expect(lockfile!.skills["pdf"]).toBeDefined();
    expect(lockfile!.subagents["code-reviewer"]).toEqual({ source: "path:agents" });
    expect(existsSync(join(projectRoot, ".agents", "agents", "code-reviewer.md"))).toBe(true);
  });

  it("does not prune outside skills dir for malformed lockfile skill names", async () => {
    const scope = resolveScope("project", projectRoot);
    const hooksDir = join(projectRoot, ".agents", "hooks");
    const pdfDir = join(projectRoot, ".agents", "skills", "pdf");
    await mkdir(hooksDir, { recursive: true });
    await mkdir(pdfDir, { recursive: true });
    await writeFile(join(hooksDir, "keep.sh"), "echo keep\n");
    await writeFile(join(pdfDir, "SKILL.md"), SKILL_MD("pdf"));
    await writeLockfile(join(projectRoot, "agents.lock"), {
      version: 1,
      skills: {
        "../hooks": {
          source: "git:https://github.com/example/repo.git",
          resolved_url: "https://github.com/example/repo.git",
          resolved_path: "pdf",
          resolved_commit: "abc123",
        },
        "stale/../pdf": {
          source: "git:https://github.com/example/repo.git",
          resolved_url: "https://github.com/example/repo.git",
          resolved_path: "pdf",
          resolved_commit: "abc123",
        },
      },
    });

    const sourceDir = join(projectRoot, "agents");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "code-reviewer.md"), SUBAGENT_MD("code-reviewer"));

    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1
[[subagents]]
name = "code-reviewer"
source = "path:agents"
path = "code-reviewer.md"
`,
    );

    await runInstall({ scope });

    expect(await readFile(join(hooksDir, "keep.sh"), "utf-8")).toBe("echo keep\n");
    expect(await readFile(join(pdfDir, "SKILL.md"), "utf-8")).toBe(SKILL_MD("pdf"));
    const lockfile = await loadLockfile(join(projectRoot, "agents.lock"));
    expect(lockfile!.skills).toEqual({});
  });

  it("prunes removed managed skills while other skills remain configured", async () => {
    const scope = resolveScope("project", projectRoot);
    const localSkillDir = join(projectRoot, ".agents", "skills", "local-skill");
    const staleSkillDir = join(projectRoot, ".agents", "skills", "pdf");
    await mkdir(localSkillDir, { recursive: true });
    await mkdir(staleSkillDir, { recursive: true });
    await writeFile(join(localSkillDir, "SKILL.md"), SKILL_MD("local-skill"));
    await writeFile(join(staleSkillDir, "SKILL.md"), SKILL_MD("pdf"));
    await writeLockfile(join(projectRoot, "agents.lock"), {
      version: 1,
      skills: {
        "local-skill": { source: "path:.agents/skills/local-skill" },
        pdf: {
          source: "git:https://github.com/example/repo.git",
          resolved_url: "https://github.com/example/repo.git",
          resolved_path: "pdf",
          resolved_commit: "abc123",
        },
      },
    });

    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1

[[skills]]
name = "local-skill"
source = "path:.agents/skills/local-skill"
`,
    );

    const result = await runInstall({ scope });

    expect(result.pruned).toEqual(["pdf"]);
    expect(existsSync(staleSkillDir)).toBe(false);
    expect(existsSync(join(localSkillDir, "SKILL.md"))).toBe(true);

    const syncResult = await runSync({ scope });
    expect(syncResult.adopted).toEqual([]);
  });

  it("preserves native Codex content through install and sync", async () => {
    const sourceDir = join(projectRoot, "upstream", ".codex", "agents");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(
      join(sourceDir, "code-reviewer.toml"),
      [
        "# upstream comment",
        'name = "code_reviewer"',
        'description = "Review code for correctness."',
        'developer_instructions = "Review the current diff."',
        'sandbox_mode = "read-only"',
        "",
      ].join("\n"),
    );

    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1
agents = ["codex", "claude"]

[[subagents]]
name = "code-reviewer"
source = "path:upstream"
`,
    );

    const scope = resolveScope("project", projectRoot);
    await runInstall({ scope });

    const codexPath = join(projectRoot, ".codex", "agents", "code-reviewer.toml");
    expect(await readFile(codexPath, "utf-8")).toContain('sandbox_mode = "read-only"');
    expect(await readFile(codexPath, "utf-8")).toContain("# upstream comment");
    expect(await readFile(codexPath, "utf-8")).toContain('name = "code_reviewer"');

    const claude = await readFile(join(projectRoot, ".claude", "agents", "code-reviewer.md"), "utf-8");
    expect(claude).not.toContain("sandbox_mode");

    await rm(codexPath);
    await runSync({ scope });

    expect(await readFile(codexPath, "utf-8")).toContain('sandbox_mode = "read-only"');
    expect(await readFile(codexPath, "utf-8")).toContain("# upstream comment");
    expect(await readFile(codexPath, "utf-8")).toContain('name = "code_reviewer"');
  });

  it("installs merged native subagent artifacts for matching runtimes", async () => {
    await mkdir(join(projectRoot, "upstream", ".claude", "agents"), { recursive: true });
    await mkdir(join(projectRoot, "upstream", ".codex", "agents"), { recursive: true });
    await writeFile(
      join(projectRoot, "upstream", ".claude", "agents", "code-reviewer.md"),
      `---
name: code-reviewer
description: Review code for correctness.
tools: Read, Grep
---

Native Claude instructions.
`,
    );
    await writeFile(
      join(projectRoot, "upstream", ".codex", "agents", "code-reviewer.toml"),
      [
        "# native codex comment",
        'name = "code_reviewer"',
        'description = "Review code for correctness."',
        'developer_instructions = "Native Codex instructions."',
        'sandbox_mode = "read-only"',
        "",
      ].join("\n"),
    );

    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1
agents = ["claude", "codex"]

[[subagents]]
name = "code-reviewer"
source = "path:upstream"
`,
    );

    await runInstall({ scope: resolveScope("project", projectRoot) });

    const claude = await readFile(join(projectRoot, ".claude", "agents", "code-reviewer.md"), "utf-8");
    expect(claude).toContain("tools: Read, Grep");
    expect(claude).toContain("Native Claude instructions.");
    expect(claude).not.toContain("sandbox_mode");

    const codex = await readFile(join(projectRoot, ".codex", "agents", "code-reviewer.toml"), "utf-8");
    expect(codex).toContain("# native codex comment");
    expect(codex).toContain('name = "code_reviewer"');
    expect(codex).toContain("Native Codex instructions.");
    expect(codex).toContain('sandbox_mode = "read-only"');

    const installed = await readFile(join(projectRoot, ".agents", "agents", "code-reviewer.md"), "utf-8");
    expect(installed).toContain("Native Claude instructions.");
    expect(installed).toContain("sandbox_mode");
  });

  it("prunes subagent files and lock entries when removed from config", async () => {
    const sourceDir = join(projectRoot, "agents");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "code-reviewer.md"), SUBAGENT_MD("code-reviewer"));

    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1
agents = ["claude"]

[[subagents]]
name = "code-reviewer"
source = "path:agents"
path = "code-reviewer.md"
`,
    );

    const scope = resolveScope("project", projectRoot);
    await runInstall({ scope });

    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1
agents = ["claude"]
`,
    );

    await runInstall({ scope });

    expect(existsSync(join(projectRoot, ".agents", "agents", "code-reviewer.md"))).toBe(false);
    expect(existsSync(join(projectRoot, ".claude", "agents", "code-reviewer.md"))).toBe(false);

    const lockfile = await loadLockfile(join(projectRoot, "agents.lock"));
    expect(lockfile!.subagents).toEqual({});
  });

  it("returns subagent warnings for unsupported agents", async () => {
    const sourceDir = join(projectRoot, "agents");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "reviewer.md"), SUBAGENT_MD("reviewer"));

    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1
agents = ["vscode"]

[[subagents]]
name = "reviewer"
source = "path:agents"
path = "reviewer.md"
`,
    );

    const scope = resolveScope("project", projectRoot);
    const result = await runInstall({ scope });
    expect(result.subagentWarnings).toHaveLength(1);
    expect(result.subagentWarnings[0]!.agent).toBe("vscode");
  });

  it("skips copy for in-place path skill", async () => {
    // Pre-install the skill directory (simulating an adopted orphan)
    const skillDir = join(projectRoot, ".agents", "skills", "local-skill");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), SKILL_MD("local-skill"));

    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "local-skill"\nsource = "path:.agents/skills/local-skill"\n`,
    );

    const scope = resolveScope("project", projectRoot);
    const result = await runInstall({ scope });
    expect(result.installed).toContain("local-skill");

    // Lockfile should have source only
    const lockfile = await loadLockfile(join(projectRoot, "agents.lock"));
    expect(lockfile).not.toBeNull();
    expect(lockfile!.skills["local-skill"]).toBeDefined();
    expect(lockfile!.skills["local-skill"]!.source).toBe("path:.agents/skills/local-skill");
  });

  it("excludes in-place skills from gitignore", async () => {
    // Pre-install the in-place skill
    const skillDir = join(projectRoot, ".agents", "skills", "local-skill");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), SKILL_MD("local-skill"));

    // Also have a sourced skill
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "local-skill"\nsource = "path:.agents/skills/local-skill"\n\n[[skills]]\nname = "pdf"\nsource = "git:${repoDir}"\n`,
    );

    const scope = resolveScope("project", projectRoot);
    await runInstall({ scope });

    const gitignore = await readFile(join(projectRoot, ".agents", ".gitignore"), "utf-8");
    // Sourced skill should be gitignored
    expect(gitignore).toContain("/skills/pdf/");
    // In-place skill should NOT be gitignored
    expect(gitignore).not.toContain("/skills/local-skill/");
  });

  it("installs all skills from a wildcard entry", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "*"\nsource = "git:${repoDir}"\n`,
    );

    const scope = resolveScope("project", projectRoot);
    const result = await runInstall({ scope });
    // Should discover and install both "pdf" and "review"
    expect(result.installed).toContain("pdf");
    expect(result.installed).toContain("review");
    expect(existsSync(join(projectRoot, ".agents", "skills", "pdf", "SKILL.md"))).toBe(true);
    expect(existsSync(join(projectRoot, ".agents", "skills", "review", "SKILL.md"))).toBe(true);
  });

  it("wildcard respects exclude list", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "*"\nsource = "git:${repoDir}"\nexclude = ["review"]\n`,
    );

    const scope = resolveScope("project", projectRoot);
    const result = await runInstall({ scope });
    expect(result.installed).toContain("pdf");
    expect(result.installed).not.toContain("review");
  });

  it("explicit entry wins over wildcard for same skill", async () => {
    // Explicit "pdf" entry + wildcard from same repo
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "pdf"\nsource = "git:${repoDir}"\n\n[[skills]]\nname = "*"\nsource = "git:${repoDir}"\n`,
    );

    const scope = resolveScope("project", projectRoot);
    const result = await runInstall({ scope });
    // "pdf" appears once (from explicit), "review" from wildcard
    const pdfCount = result.installed.filter((n) => n === "pdf").length;
    expect(pdfCount).toBe(1);
    expect(result.installed).toContain("review");
  });

  it("wildcard creates lockfile with all discovered skills", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "*"\nsource = "git:${repoDir}"\n`,
    );

    const scope = resolveScope("project", projectRoot);
    await runInstall({ scope });

    const lockfile = await loadLockfile(join(projectRoot, "agents.lock"));
    expect(lockfile).not.toBeNull();
    expect(lockfile!.skills["pdf"]).toBeDefined();
    expect(lockfile!.skills["review"]).toBeDefined();
  });

  it("frozen mode works with wildcard lockfile", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "*"\nsource = "git:${repoDir}"\n`,
    );

    const scope = resolveScope("project", projectRoot);
    // First install to create lockfile
    await runInstall({ scope });

    // Second install with --frozen
    const result = await runInstall({ scope, frozen: true });
    expect(result.installed).toContain("pdf");
    expect(result.installed).toContain("review");
  });

  it("wildcard-expanded skills are gitignored", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "*"\nsource = "git:${repoDir}"\n`,
    );

    const scope = resolveScope("project", projectRoot);
    await runInstall({ scope });

    const gitignore = await readFile(join(projectRoot, ".agents", ".gitignore"), "utf-8");
    expect(gitignore).toContain("/skills/pdf/");
    expect(gitignore).toContain("/skills/review/");
  });

  it("errors on name conflict between two wildcard sources", async () => {
    // Create a second repo that also has a "pdf" skill
    const repoDir2 = join(tmpDir, "repo2");
    await mkdir(repoDir2, { recursive: true });
    await initTestGitRepo(repoDir2);
    await mkdir(join(repoDir2, "pdf"), { recursive: true });
    await writeFile(join(repoDir2, "pdf", "SKILL.md"), SKILL_MD("pdf"));
    await exec("git", ["add", "."], { cwd: repoDir2 });
    await exec("git", ["commit", "-m", "initial"], { cwd: repoDir2 });

    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "*"\nsource = "git:${repoDir}"\n\n[[skills]]\nname = "*"\nsource = "git:${repoDir2}"\n`,
    );

    const scope = resolveScope("project", projectRoot);
    await expect(runInstall({ scope })).rejects.toThrow(/found in both wildcard sources/);
  });

  it("prunes stale wildcard skills on re-install", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "*"\nsource = "git:${repoDir}"\n`,
    );

    const scope = resolveScope("project", projectRoot);

    // First install — gets both "pdf" and "review"
    const first = await runInstall({ scope });
    expect(first.installed).toContain("pdf");
    expect(first.installed).toContain("review");
    expect(first.pruned).toHaveLength(0);

    // Remove "review" from upstream repo
    await ensureGitRepo();
    await exec("git", ["rm", "-rf", "skills/review"], { cwd: repoDir });
    await exec("git", ["commit", "-m", "remove review"], { cwd: repoDir });

    // Re-install — should fetch latest without needing --force or cache bust
    const second = await runInstall({ scope });
    expect(second.installed).toContain("pdf");
    expect(second.installed).not.toContain("review");
    expect(second.pruned).toContain("review");

    // Skill directory should be gone
    expect(existsSync(join(projectRoot, ".agents", "skills", "review"))).toBe(false);
    // pdf should still be intact
    expect(existsSync(join(projectRoot, ".agents", "skills", "pdf", "SKILL.md"))).toBe(true);

    // Lockfile should not contain review
    const lock = await loadLockfile(join(projectRoot, "agents.lock"));
    expect(lock!.skills["review"]).toBeUndefined();
    expect(lock!.skills["pdf"]).toBeDefined();
  });

  it("prunes stale managed skills whose source does not match a wildcard", async () => {
    // Create a second repo with a "helper" skill
    const repoDir2 = join(tmpDir, "repo2");
    await mkdir(repoDir2, { recursive: true });
    await initTestGitRepo(repoDir2);
    await mkdir(join(repoDir2, "helper"), { recursive: true });
    await writeFile(join(repoDir2, "helper", "SKILL.md"), SKILL_MD("helper"));
    await exec("git", ["add", "."], { cwd: repoDir2 });
    await exec("git", ["commit", "-m", "initial"], { cwd: repoDir2 });

    // Install explicit "helper" from repo2 + wildcard from repo1
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "helper"\nsource = "git:${repoDir2}"\n\n[[skills]]\nname = "*"\nsource = "git:${repoDir}"\n`,
    );

    const scope = resolveScope("project", projectRoot);
    await runInstall({ scope });

    // Remove "helper" from agents.toml (keep wildcard only)
    // Also remove "review" from upstream so it gets pruned
    await ensureGitRepo();
    await exec("git", ["rm", "-rf", "skills/review"], { cwd: repoDir });
    await exec("git", ["commit", "-m", "remove review"], { cwd: repoDir });

    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "*"\nsource = "git:${repoDir}"\n`,
    );

    const result = await runInstall({ scope });

    // "review" was from the wildcard source and was removed upstream — should be pruned
    expect(result.pruned).toContain("review");
    // "helper" was removed from config, so it should also be pruned
    expect(result.pruned).toContain("helper");
    expect(existsSync(join(projectRoot, ".agents", "skills", "helper"))).toBe(false);
  });

  it("prunes skills added to wildcard exclude list", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "*"\nsource = "git:${repoDir}"\n`,
    );

    const scope = resolveScope("project", projectRoot);

    // First install — gets both
    await runInstall({ scope });
    expect(existsSync(join(projectRoot, ".agents", "skills", "review", "SKILL.md"))).toBe(true);

    // Add "review" to the exclude list
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "*"\nsource = "git:${repoDir}"\nexclude = ["review"]\n`,
    );

    const result = await runInstall({ scope });
    expect(result.installed).toContain("pdf");
    expect(result.installed).not.toContain("review");
    expect(result.pruned).toContain("review");

    // Directory should be gone
    expect(existsSync(join(projectRoot, ".agents", "skills", "review"))).toBe(false);
  });

  it("does not prune in frozen mode", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "*"\nsource = "git:${repoDir}"\n`,
    );

    const scope = resolveScope("project", projectRoot);

    // First install — gets both "pdf" and "review"
    await runInstall({ scope });

    // Add "review" to the exclude list
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "*"\nsource = "git:${repoDir}"\nexclude = ["review"]\n`,
    );

    // Frozen install should NOT prune (would create disk/lockfile inconsistency)
    const result = await runInstall({ scope, frozen: true });
    expect(result.pruned).toHaveLength(0);
    // Directory should still exist
    expect(existsSync(join(projectRoot, ".agents", "skills", "review", "SKILL.md"))).toBe(true);
  });

  it("does not prune installed subagents in frozen mode", async () => {
    const sourceDir = join(projectRoot, "agents");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "code-reviewer.md"), SUBAGENT_MD("code-reviewer"));

    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1
agents = ["claude"]

[[subagents]]
name = "code-reviewer"
source = "path:agents"
path = "code-reviewer.md"
`,
    );

    const scope = resolveScope("project", projectRoot);
    await runInstall({ scope });

    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1
agents = ["claude"]
`,
    );

    const result = await runInstall({ scope, frozen: true });

    expect(result.pruned).toEqual([]);
    expect(existsSync(join(projectRoot, ".agents", "agents", "code-reviewer.md"))).toBe(true);
    expect(existsSync(join(projectRoot, ".claude", "agents", "code-reviewer.md"))).toBe(true);
    const gitignore = await readFile(join(projectRoot, ".agents", ".gitignore"), "utf-8");
    expect(gitignore).toContain("/agents/code-reviewer.md");
    const lockfile = await loadLockfile(join(projectRoot, "agents.lock"));
    expect(lockfile!.subagents["code-reviewer"]).toBeDefined();
  });

  it("wildcard with all skills excluded installs nothing from that source", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "*"\nsource = "git:${repoDir}"\nexclude = ["pdf", "review"]\n`,
    );

    const scope = resolveScope("project", projectRoot);
    const result = await runInstall({ scope });
    expect(result.installed).toHaveLength(0);
  });

  it("frozen mode fails when skill missing from lockfile", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "pdf"\nsource = "git:${repoDir}"\n`,
    );
    const scope = resolveScope("project", projectRoot);
    await runInstall({ scope });

    // Add review to config but lockfile still has only pdf
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "pdf"\nsource = "git:${repoDir}"\n\n[[skills]]\nname = "review"\nsource = "git:${repoDir}"\n`,
    );

    await expect(runInstall({ scope, frozen: true })).rejects.toThrow(InstallError);
  });

  it("does not auto-create root .gitignore", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "pdf"\nsource = "git:${repoDir}"\n`,
    );

    const scope = resolveScope("project", projectRoot);
    await runInstall({ scope });

    // Only init creates .gitignore — install should not
    expect(existsSync(join(projectRoot, ".gitignore"))).toBe(false);
  });

  it("picks up upstream skill changes without --force", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "pdf"\nsource = "git:${repoDir}"\n`,
    );

    const scope = resolveScope("project", projectRoot);

    // First install
    const first = await runInstall({ scope });
    expect(first.installed).toContain("pdf");

    const original = await readFile(
      join(projectRoot, ".agents", "skills", "pdf", "SKILL.md"),
      "utf-8",
    );

    // Update the skill upstream
    await ensureGitRepo();
    await writeFile(join(repoDir, "pdf", "SKILL.md"), `${SKILL_MD("pdf")}\nupdated content`);
    await exec("git", ["add", "."], { cwd: repoDir });
    await exec("git", ["commit", "-m", "update pdf skill"], { cwd: repoDir });

    // Re-install — should pick up the change without --force or cache bust
    await runInstall({ scope });

    const updated = await readFile(
      join(projectRoot, ".agents", "skills", "pdf", "SKILL.md"),
      "utf-8",
    );
    expect(updated).toContain("updated content");
    expect(updated).not.toBe(original);
  });

  it("minimum_release_age resolves to an older commit when HEAD is too new", async () => {
    // Create an old commit (backdated) then a new one
    await ensureGitRepo();
    await exec("git", ["rm", "-rf", "pdf", "skills"], { cwd: repoDir });
    await exec("git", ["commit", "-m", "clear"], { cwd: repoDir });

    // Create the old commit with a backdated author date
    await mkdir(join(repoDir, "pdf"), { recursive: true });
    await writeFile(join(repoDir, "pdf", "SKILL.md"), SKILL_MD("pdf"));
    await exec("git", ["add", "."], { cwd: repoDir });
    await exec("git", ["commit", "-m", "old commit", "--date", "2020-01-01T00:00:00"], {
      cwd: repoDir,
      env: { ...process.env, GIT_COMMITTER_DATE: "2020-01-01T00:00:00" },
    });

    const { stdout: oldSha } = await exec("git", ["rev-parse", "HEAD"], { cwd: repoDir });

    // Create a brand new commit (today)
    await writeFile(join(repoDir, "pdf", "SKILL.md"), `${SKILL_MD("pdf")}\nupdated`);
    await exec("git", ["add", "."], { cwd: repoDir });
    await exec("git", ["commit", "-m", "new commit"], { cwd: repoDir });

    const { stdout: newSha } = await exec("git", ["rev-parse", "HEAD"], { cwd: repoDir });
    expect(oldSha.trim()).not.toBe(newSha.trim());

    // Install with minimum_release_age = 1 — should skip the brand-new commit and use the old one
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\nminimum_release_age = 1\n\n[[skills]]\nname = "pdf"\nsource = "git:${repoDir}"\n`,
    );

    const scope = resolveScope("project", projectRoot);
    const result = await runInstall({ scope });
    expect(result.installed).toContain("pdf");

    const lockfile = await loadLockfile(join(projectRoot, "agents.lock"));
    expect(lockfile).not.toBeNull();
    expect(lockfile!.skills["pdf"]!).toBeDefined();
    // Should have resolved to the old commit, not HEAD
    const locked = lockfile!.skills["pdf"]! as { resolved_commit?: string };
    expect(locked.resolved_commit).toBe(oldSha.trim());
  });

  it("minimum_release_age throws when repo is younger than threshold", async () => {
    // All commits in repoDir are recent (created in beforeEach)
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\nminimum_release_age = 9999\n\n[[skills]]\nname = "pdf"\nsource = "git:${repoDir}"\n`,
    );

    const scope = resolveScope("project", projectRoot);
    await expect(runInstall({ scope })).rejects.toThrow(/minimum_release_age/);
  });

  it("minimum_release_age rejects pinned skills that are too new", async () => {
    await ensureGitRepo();
    const { stdout: sha } = await exec("git", ["rev-parse", "HEAD"], { cwd: repoDir });

    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\nminimum_release_age = 9999\n\n[[skills]]\nname = "pdf"\nsource = "git:${repoDir}"\nref = "${sha.trim()}"\n`,
    );

    const scope = resolveScope("project", projectRoot);
    await expect(runInstall({ scope })).rejects.toThrow(/minimum_release_age/);
  });

  it("minimum_release_age_exclude bypasses age gate for matching sources", async () => {
    // All commits are recent, but the source is excluded — should install fine
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\nminimum_release_age = 9999\nminimum_release_age_exclude = ["git:${repoDir}"]\n\n[[skills]]\nname = "pdf"\nsource = "git:${repoDir}"\n`,
    );

    const scope = resolveScope("project", projectRoot);
    const result = await runInstall({ scope });
    expect(result.installed).toContain("pdf");
  });

  it("minimum_release_age_exclude with org pattern bypasses age gate", async () => {
    // Use a GitHub-style source with an org exclude
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\nminimum_release_age = 9999\nminimum_release_age_exclude = ["myorg"]\n\n[[skills]]\nname = "pdf"\nsource = "myorg/skills"\n`,
    );

    // This will fail to clone (myorg/skills doesn't exist), but it should fail
    // at clone time, not at the age gate — proving the exclude is working.
    const scope = resolveScope("project", projectRoot);
    await expect(runInstall({ scope })).rejects.toThrow(/clone|resolve/i);
  });
});
