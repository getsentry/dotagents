import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, rm, lstat, access, readdir, readlink, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import install, { runInstall as runInstallCommand, InstallError, type InstallOptions, type InstallResult } from "./install.js";
import { runSync } from "./sync.js";
import { exec, type SerializedObject } from "@sentry/dotagents-lib";
import { loadLockfile } from "../../lockfile/loader.js";
import { writeLockfile } from "../../lockfile/writer.js";
import type { Lockfile } from "../../lockfile/schema.js";
import { resolveScope } from "../../scope.js";
import { DOTAGENTS_SUBAGENT_MARKER } from "../../subagents/format.js";
import {
  DOTAGENTS_MANAGED_PLUGIN_MARKER,
  DOTAGENTS_NATIVE_FALLBACKS_MARKER,
} from "../../plugins/store.js";
import { AGENT_PLUGIN_MCP_SCHEMA, AGENT_PLUGIN_SCHEMA } from "../../plugins/schema.js";

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

const HYBRID_TARGET_CONFIG = (targets: string[]) => `version = 1
agents = ["claude", "cursor"]

[[plugins]]
name = "hybrid-tools"
source = "path:plugin-source/hybrid-tools"
targets = [${targets.map((target) => `"${target}"`).join(", ")}]
`;

type HarnessEntry =
  | { json: unknown }
  | { text: string }
  | { symlink: string };

function componentMarkerContent(linkPath: string, targetPath: string): string {
  return `managedBy=dotagents\ntarget=${JSON.stringify(relative(dirname(linkPath), targetPath))}\n`;
}

async function expectHarnessFiles(
  projectRoot: string,
  roots: string[],
  expected: Record<string, HarnessEntry>,
): Promise<void> {
  const actual = new Set<string>();

  const collect = async (relativePath: string): Promise<void> => {
    const filePath = join(projectRoot, relativePath);
    if (!existsSync(filePath)) {return;}
    const stat = await lstat(filePath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      actual.add(relativePath);
      return;
    }
    for (const entry of await readdir(filePath, { withFileTypes: true })) {
      await collect(join(relativePath, entry.name));
    }
  };

  for (const root of roots) {
    await collect(root);
    await collect(`${root}.dotagents-managed`);
  }
  expect([...actual].toSorted()).toEqual(Object.keys(expected).toSorted());

  for (const [relativePath, entry] of Object.entries(expected)) {
    const filePath = join(projectRoot, relativePath);
    if ("symlink" in entry) {
      expect((await lstat(filePath)).isSymbolicLink()).toBe(true);
      expect(resolve(dirname(filePath), await readlink(filePath))).toBe(entry.symlink);
    } else if ("json" in entry) {
      expect(JSON.parse(await readFile(filePath, "utf-8"))).toEqual(entry.json);
    } else {
      expect(await readFile(filePath, "utf-8")).toBe(entry.text);
    }
  }
}

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

  it("installs configured skills and records their durable state", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "pdf"\nsource = "git:${repoDir}"\n\n[[skills]]\nname = "review"\nsource = "git:${repoDir}"\n`,
    );

    const scope = resolveScope("project", projectRoot);
    const result = await runInstall({ scope });
    expect(result.installed.toSorted()).toEqual(["pdf", "review"]);

    expect(existsSync(join(projectRoot, ".agents", "skills", "pdf", "SKILL.md"))).toBe(true);
    expect(existsSync(join(projectRoot, ".agents", "skills", "pdf", "prompt.md"))).toBe(true);
    expect(existsSync(join(projectRoot, ".agents", "skills", "review", "SKILL.md"))).toBe(true);

    const lockfile = await loadLockfile(join(projectRoot, "agents.lock"));
    expect(lockfile).not.toBeNull();
    expect(Object.keys(lockfile!.skills).toSorted()).toEqual(["pdf", "review"]);
    for (const entry of Object.values(lockfile!.skills)) {
      expect(entry.source).toBeDefined();
      expect("resolved_commit" in entry).toBe(true);
      expect("integrity" in entry).toBe(false);
    }

    const gitignore = await readFile(join(projectRoot, ".agents", ".gitignore"), "utf-8");
    expect(gitignore).toContain("/skills/pdf");
    expect(gitignore).toContain("/skills/review");
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

    const codexMarketplace = JSON.parse(await readFile(join(projectRoot, ".agents", "plugins", "marketplace.json"), "utf-8")) as SerializedObject;
    expect(codexMarketplace).toEqual({
      interface: {
        displayName: "Dotagents Plugins",
      },
      name: "dotagents-local",
      owner: {
        name: "dotagents",
      },
      plugins: [
        {
          category: "Coding",
          description: "Review workflow helpers",
          name: "review-tools",
          policy: {
            authentication: "ON_INSTALL",
            installation: "AVAILABLE",
          },
          source: {
            path: "./.agents/plugins/review-tools",
            source: "local",
          },
          version: "1.0.0",
        },
      ],
    });
    const codexPlugin = (codexMarketplace["plugins"] as Array<{ source: { path: string } }>)[0]!;
    expect(resolve(projectRoot, codexPlugin["source"].path)).toBe(
      join(projectRoot, ".agents", "plugins", "review-tools"),
    );

    const claudeMarketplaceJson = await readFile(join(projectRoot, ".claude-plugin", "marketplace.json"), "utf-8");
    expect(claudeMarketplaceJson).toBe(`{
  "description": "Generated by dotagents",
  "name": "dotagents",
  "owner": {
    "name": "dotagents"
  },
  "plugins": [
    {
      "description": "Review workflow helpers",
      "name": "review-tools",
      "source": "./.agents/plugins/review-tools",
      "version": "1.0.0"
    }
  ]
}
`);
    const claudeMarketplace = JSON.parse(claudeMarketplaceJson) as { plugins: Array<{ source: string }> };
    expect(resolve(projectRoot, claudeMarketplace["plugins"][0]!["source"])).toBe(
      join(projectRoot, ".agents", "plugins", "review-tools"),
    );
    expect(await readFile(join(projectRoot, ".cursor-plugin", "marketplace.json"), "utf-8")).toBe(claudeMarketplaceJson);

    const claudeManifest = JSON.parse(await readFile(join(projectRoot, ".agents", "plugins", "review-tools", ".claude-plugin", "plugin.json"), "utf-8")) as SerializedObject;
    expect(claudeManifest["name"]).toBe("review-tools");
    expect(claudeManifest["skills"]).toBe("./skills");
    expect(claudeManifest["commands"]).toBe("./commands");
    expect(claudeManifest["agents"]).toBeUndefined();
    expect(claudeManifest["category"]).toBeUndefined();
    expect(claudeManifest["metadata"]).toBeUndefined();

    const codexManifest = JSON.parse(await readFile(join(projectRoot, ".agents", "plugins", "review-tools", ".codex-plugin", "plugin.json"), "utf-8")) as SerializedObject;
    expect(codexManifest["name"]).toBe("review-tools");
    expect(codexManifest["skills"]).toBe("./skills");
    expect(codexManifest["commands"]).toBe("./commands");
    expect(codexManifest["x-extra"]).toEqual({ kept: true });

    const agentsGitignore = await readFile(join(projectRoot, ".agents", ".gitignore"), "utf-8");
    expect(agentsGitignore).toContain("/plugins/review-tools/");
  });

  it.each(["claude", "cursor", "codex", "grok", "opencode", "pi"] as const)(
    "compiles an Agent Plugins v1 bundle into the complete %s harness",
    async (target) => {
      const sourceDir = join(projectRoot, "plugin-source", "portable-tools");
      await mkdir(join(sourceDir, "linked-skills", "portable-qa"), { recursive: true });
      await mkdir(join(sourceDir, "com.example.client", "agents"), { recursive: true });
      await mkdir(join(sourceDir, "com.example.client", "commands"), { recursive: true });
      const sourceManifest = {
        $schema: AGENT_PLUGIN_SCHEMA,
        name: "portable-tools",
        description: "Portable QA tools",
        version: "1.0.0",
        author: { name: "dotagents" },
        extensions: { "com.example.client": { enabled: true } },
      };
      const mcpConfig = {
        $schema: AGENT_PLUGIN_MCP_SCHEMA,
        mcpServers: {
          "portable-stdio": {
            type: "stdio",
            command: "node",
            args: ["${PLUGIN_ROOT}/server.mjs"],
            env: { CACHE: "${PLUGIN_DATA}/cache" },
            cwd: "${PLUGIN_ROOT}",
          },
          "portable-http": {
            type: "streamable-http",
            url: "https://example.com/mcp",
            headers: { "X-Fixture": "dotagents" },
          },
        },
      };
      const extensionAgent = "client extension agent";
      const extensionCommand = "client extension command";
      const serverSource = 'import { writeFileSync } from "node:fs";\nwriteFileSync(new URL("./executed", import.meta.url), "executed");\n';
      await writeFile(join(sourceDir, "plugin.json"), JSON.stringify(sourceManifest, null, 2));
      await writeFile(join(sourceDir, "mcp.json"), JSON.stringify(mcpConfig, null, 2));
      await writeFile(join(sourceDir, "server.mjs"), serverSource);
      await writeFile(join(sourceDir, "linked-skills", "portable-qa", "SKILL.md"), SKILL_MD("portable-qa"));
      await symlink("linked-skills", join(sourceDir, "skills"));
      await writeFile(join(sourceDir, "com.example.client", "agents", "should-not-project.md"), extensionAgent);
      await writeFile(join(sourceDir, "com.example.client", "commands", "should-not-project.md"), extensionCommand);
      await writeFile(
        join(projectRoot, "agents.toml"),
        `version = 1
agents = ["${target}"]

[[plugins]]
name = "portable-tools"
source = "path:plugin-source/portable-tools"
`,
      );

      const scope = resolveScope("project", projectRoot);
      const result = await runInstall({ scope });
      expect(result.installedPlugins).toEqual(["portable-tools"]);

      const installedDir = join(projectRoot, ".agents", "plugins", "portable-tools");
      const portableSkillDir = join(installedDir, "skills", "portable-qa");
      const nativeManifest = {
        author: { name: "dotagents" },
        description: "Portable QA tools",
        mcpServers: "./mcp.json",
        name: "portable-tools",
        skills: "./skills",
        version: "1.0.0",
      };
      const codexManifest = {
        author: { name: "dotagents" },
        description: "Portable QA tools",
        interface: {
          capabilities: ["Interactive", "Write"],
          category: "Coding",
          developerName: "dotagents",
          displayName: "Portable Tools",
          shortDescription: "Portable QA tools",
        },
        mcpServers: "./mcp.json",
        name: "portable-tools",
        skills: "./skills",
        version: "1.0.0",
      };
      const canonicalFiles: Record<string, HarnessEntry> = {
        ".agents/plugins/portable-tools/.dotagents-managed": { text: "managedBy=dotagents\n" },
        ".agents/plugins/portable-tools/com.example.client/agents/should-not-project.md": { text: extensionAgent },
        ".agents/plugins/portable-tools/com.example.client/commands/should-not-project.md": { text: extensionCommand },
        ".agents/plugins/portable-tools/linked-skills/portable-qa/SKILL.md": { text: SKILL_MD("portable-qa") },
        ".agents/plugins/portable-tools/mcp.json": { json: mcpConfig },
        ".agents/plugins/portable-tools/plugin.json": { json: sourceManifest },
        ".agents/plugins/portable-tools/server.mjs": { text: serverSource },
        ".agents/plugins/portable-tools/skills": { symlink: join(installedDir, "linked-skills") },
      };
      const addNativeManifest = (dir: string, manifest: unknown): void => {
        canonicalFiles[`.agents/plugins/portable-tools/${dir}/plugin.json`] = { json: manifest };
        canonicalFiles[`.agents/plugins/portable-tools/${dir}/plugin.json.dotagents-managed`] = { text: "managedBy=dotagents\n" };
      };
      if (target === "claude") {addNativeManifest(".claude-plugin", nativeManifest);}
      if (target === "cursor") {addNativeManifest(".cursor-plugin", nativeManifest);}
      if (target === "codex") {addNativeManifest(".codex-plugin", codexManifest);}
      await expectHarnessFiles(projectRoot, [".agents/plugins/portable-tools"], canonicalFiles);

      if (target === "claude" || target === "cursor") {
        const marketplaceDir = target === "claude" ? ".claude-plugin" : ".cursor-plugin";
        await expectHarnessFiles(projectRoot, [marketplaceDir], {
          [`${marketplaceDir}/marketplace.json`]: { json: {
            description: "Generated by dotagents",
            name: "dotagents",
            owner: { name: "dotagents" },
            plugins: [{
              description: "Portable QA tools",
              name: "portable-tools",
              source: "./.agents/plugins/portable-tools",
              version: "1.0.0",
            }],
          } },
          [`${marketplaceDir}/marketplace.json.dotagents-managed`]: { text: "managedBy=dotagents\n" },
        });
      } else if (target === "codex") {
        await expectHarnessFiles(projectRoot, [".agents/plugins/marketplace.json"], {
          ".agents/plugins/marketplace.json": { json: {
            interface: { displayName: "Dotagents Plugins" },
            name: "dotagents-local",
            owner: { name: "dotagents" },
            plugins: [{
              category: "Productivity",
              description: "Portable QA tools",
              name: "portable-tools",
              policy: { authentication: "ON_INSTALL", installation: "AVAILABLE" },
              source: { path: "./.agents/plugins/portable-tools", source: "local" },
              version: "1.0.0",
            }],
          } },
          ".agents/plugins/marketplace.json.dotagents-managed": { text: "managedBy=dotagents\n" },
        });
      } else if (target === "grok") {
        await expectHarnessFiles(projectRoot, [".grok/plugins/portable-tools"], {
          ".grok/plugins/portable-tools/.dotagents-managed": { text: "Generated by dotagents. Do not edit.\n" },
          ".grok/plugins/portable-tools/com.example.client/agents/should-not-project.md": { text: extensionAgent },
          ".grok/plugins/portable-tools/com.example.client/commands/should-not-project.md": { text: extensionCommand },
          ".grok/plugins/portable-tools/linked-skills/portable-qa/SKILL.md": { text: SKILL_MD("portable-qa") },
          ".grok/plugins/portable-tools/mcp.json": { json: mcpConfig },
          ".grok/plugins/portable-tools/plugin.json": { json: sourceManifest },
          ".grok/plugins/portable-tools/server.mjs": { text: serverSource },
          ".grok/plugins/portable-tools/skills": { symlink: join(projectRoot, ".grok", "plugins", "portable-tools", "linked-skills") },
        });
      } else if (target === "opencode") {
        const linkPath = join(projectRoot, ".opencode", "skills", "portable-qa");
        await expectHarnessFiles(projectRoot, [".opencode/skills", ".opencode/agents"], {
          ".opencode/skills/portable-qa": { symlink: portableSkillDir },
          ".opencode/skills/.dotagents-managed/portable-qa": { text: componentMarkerContent(linkPath, portableSkillDir) },
        });
      } else {
        const linkPath = join(projectRoot, ".agents", "skills", "portable-qa");
        await expectHarnessFiles(projectRoot, [".agents/skills"], {
          ".agents/skills/portable-qa": { symlink: portableSkillDir },
          ".agents/skills/.dotagents-managed/portable-qa": { text: componentMarkerContent(linkPath, portableSkillDir) },
        });
      }

      const targetOutputPaths: Record<typeof target, string[]> = {
        claude: [".claude-plugin"],
        cursor: [".cursor-plugin"],
        codex: [".agents/plugins/marketplace.json"],
        grok: [".grok/plugins/portable-tools"],
        opencode: [
          ".opencode/skills/portable-qa",
          ".opencode/skills/.dotagents-managed/portable-qa",
          ".opencode/agents",
        ],
        pi: [".agents/skills/portable-qa", ".agents/skills/.dotagents-managed/portable-qa"],
      };
      await runSync({ scope });
      for (const [otherTarget, paths] of Object.entries(targetOutputPaths)) {
        if (otherTarget === target) {continue;}
        for (const path of paths) {
          expect(existsSync(join(projectRoot, path)), `${target} unexpectedly wrote ${path}`).toBe(false);
        }
      }
      expect(existsSync(join(sourceDir, "executed"))).toBe(false);
      expect(existsSync(join(installedDir, "executed"))).toBe(false);
    },
  );

  it.each([undefined, "."] as const)(
    "installs a reported-shape hybrid root with path %s",
    async (pluginPath) => {
      const sourceDir = join(projectRoot, "hybrid-source");
      const claudeBytes = '{\n  "name": "hybrid-tools",\n  "description": "Hybrid tools",\n  "commands": "./commands",\n  "hooks": "./hooks/hooks.json"\n}\n';
      await mkdir(join(sourceDir, ".claude-plugin"), { recursive: true });
      await mkdir(join(sourceDir, ".codex-plugin"), { recursive: true });
      await mkdir(join(sourceDir, "skills", "portable-qa"), { recursive: true });
      await mkdir(join(sourceDir, "commands"), { recursive: true });
      await mkdir(join(sourceDir, "agents"), { recursive: true });
      await mkdir(join(sourceDir, "hooks"), { recursive: true });
      await writeFile(join(sourceDir, "plugin.json"), JSON.stringify({
        $schema: AGENT_PLUGIN_SCHEMA,
        name: "hybrid-tools",
        description: "Hybrid tools",
      }, null, 2));
      await writeFile(join(sourceDir, ".claude-plugin", "plugin.json"), claudeBytes);
      await writeFile(join(sourceDir, ".codex-plugin", "plugin.json"), JSON.stringify({
        name: "hybrid-tools",
        description: "Hybrid tools",
        agents: "./agents",
      }, null, 2));
      await writeFile(join(sourceDir, "skills", "portable-qa", "SKILL.md"), SKILL_MD("portable-qa"));
      await writeFile(join(sourceDir, "commands", "native.md"), "native command");
      await writeFile(join(sourceDir, "agents", "native.md"), "native agent");
      await writeFile(join(sourceDir, "hooks", "hooks.json"), "{}");
      await writeFile(join(sourceDir, "marketplace.json"), JSON.stringify({
        name: "external-catalog",
        plugins: [{
          name: "hybrid-tools",
          source: { source: "github", repo: "example/hybrid-tools" },
        }],
      }));
      await writeFile(join(projectRoot, "agents.toml"), `version = 1
agents = ["claude", "opencode"]

[[plugins]]
name = "hybrid-tools"
source = "path:hybrid-source"
${pluginPath ? `path = "${pluginPath}"\n` : ""}`);

      const scope = resolveScope("project", projectRoot);
      const result = await runInstall({ scope });
      const installedDir = join(projectRoot, ".agents", "plugins", "hybrid-tools");

      expect(result.installedPlugins).toEqual(["hybrid-tools"]);
      expect(result.pluginWarnings).toEqual([{
        agent: "plugin",
        name: "hybrid-tools",
        message: 'Plugin "hybrid-tools" is a hybrid compatibility bundle: the portable core remains authoritative; authored Claude, Codex interfaces are retained only as matching-client fallbacks.',
      }]);
      expect(await readFile(join(installedDir, ".claude-plugin", "plugin.json"), "utf-8")).toBe(claudeBytes);
      expect(existsSync(join(installedDir, ".claude-plugin", "plugin.json.dotagents-managed"))).toBe(false);
      expect(existsSync(join(projectRoot, ".opencode", "skills", "portable-qa"))).toBe(true);
      expect(existsSync(join(projectRoot, ".opencode", "agents", "native.md"))).toBe(false);
      expect(existsSync(join(projectRoot, ".codex-plugin", "marketplace.json"))).toBe(false);
      expect((await loadLockfile(scope.lockPath))!.plugins["hybrid-tools"]).toEqual({
        source: "path:hybrid-source",
      });

      const sync = await runSync({ scope });
      expect(sync.issues.some((issue) => issue.message === result.pluginWarnings[0]!.message)).toBe(true);
      expect(await readFile(join(installedDir, ".claude-plugin", "plugin.json"), "utf-8")).toBe(claudeBytes);
    },
  );

  it("replaces a reproducible native interface with a managed portable adapter", async () => {
    const sourceDir = join(projectRoot, "plugin-source", "hybrid-tools");
    await mkdir(join(sourceDir, ".claude-plugin"), { recursive: true });
    await mkdir(join(sourceDir, "skills", "portable-qa"), { recursive: true });
    await writeFile(join(sourceDir, "plugin.json"), JSON.stringify({
      $schema: AGENT_PLUGIN_SCHEMA,
      name: "hybrid-tools",
      description: "Portable description",
    }));
    await writeFile(join(sourceDir, ".claude-plugin", "plugin.json"), JSON.stringify({
      name: "hybrid-tools",
      description: "Native description",
      skills: "./skills",
    }));
    await writeFile(join(sourceDir, "skills", "portable-qa", "SKILL.md"), SKILL_MD("portable-qa"));
    await writeFile(join(projectRoot, "agents.toml"), HYBRID_TARGET_CONFIG(["claude"]));

    const scope = resolveScope("project", projectRoot);
    const result = await runInstall({ scope });
    const installedDir = join(scope.pluginsDir, "hybrid-tools");
    const manifestPath = join(installedDir, ".claude-plugin", "plugin.json");

    expect(JSON.parse(await readFile(manifestPath, "utf-8"))).toMatchObject({
      name: "hybrid-tools",
      description: "Portable description",
      skills: "./skills",
    });
    expect(existsSync(`${manifestPath}.dotagents-managed`)).toBe(true);
    expect(existsSync(join(installedDir, DOTAGENTS_NATIVE_FALLBACKS_MARKER))).toBe(false);
    expect(result.pluginWarnings.map((warning) => warning.message)).toEqual([
      'Plugin "hybrid-tools" is a hybrid compatibility bundle: the portable core remains authoritative; redundant authored native interfaces are ignored in favor of portable generation.',
      'Plugin "hybrid-tools" has an authored Claude interface that was ignored because the portable core can generate the Claude adapter.',
    ]);
  });

  it("preflights all selected native interfaces before canonical or lockfile mutations", async () => {
    const validDir = join(projectRoot, "plugin-source", "valid-tools");
    const invalidDir = join(projectRoot, "plugin-source", "invalid-tools");
    await mkdir(validDir, { recursive: true });
    await mkdir(join(invalidDir, ".claude-plugin"), { recursive: true });
    await writeFile(join(validDir, "plugin.json"), JSON.stringify({
      $schema: AGENT_PLUGIN_SCHEMA,
      name: "valid-tools",
    }));
    await writeFile(join(invalidDir, "plugin.json"), JSON.stringify({
      $schema: AGENT_PLUGIN_SCHEMA,
      name: "invalid-tools",
    }));
    await writeFile(join(invalidDir, ".claude-plugin", "plugin.json"), JSON.stringify({
      name: "invalid-tools",
      commands: "../outside",
    }));
    const originalLock: Lockfile = {
      version: 1,
      skills: {},
      subagents: {},
      plugins: { previous: { source: "path:previous" } },
    };
    await writeLockfile(join(projectRoot, "agents.lock"), originalLock);
    await writeFile(join(projectRoot, "agents.toml"), `version = 1
agents = ["claude"]

[[plugins]]
name = "valid-tools"
source = "path:plugin-source/valid-tools"

[[plugins]]
name = "invalid-tools"
source = "path:plugin-source/invalid-tools"
`);

    const scope = resolveScope("project", projectRoot);
    await expect(runInstall({ scope })).rejects.toThrow("Invalid Claude native fallback");

    expect(existsSync(join(scope.pluginsDir, "valid-tools"))).toBe(false);
    expect(existsSync(join(scope.pluginsDir, "invalid-tools"))).toBe(false);
    expect(await loadLockfile(scope.lockPath)).toEqual(originalLock);
    expect(existsSync(join(projectRoot, ".claude-plugin", "marketplace.json"))).toBe(false);
  });

  it("preserves and warns about a malformed unselected native interface", async () => {
    const sourceDir = join(projectRoot, "plugin-source", "hybrid-tools");
    await mkdir(join(sourceDir, ".claude-plugin"), { recursive: true });
    await writeFile(join(sourceDir, "plugin.json"), JSON.stringify({
      $schema: AGENT_PLUGIN_SCHEMA,
      name: "hybrid-tools",
    }));
    const malformedBytes = '{ "name": "hybrid-tools", "commands": "../outside" }\n';
    await writeFile(join(sourceDir, ".claude-plugin", "plugin.json"), malformedBytes);
    await writeFile(join(projectRoot, "agents.toml"), `version = 1
agents = ["codex"]

[[plugins]]
name = "hybrid-tools"
source = "path:plugin-source/hybrid-tools"
targets = ["claude"]
`);

    const result = await runInstall({ scope: resolveScope("project", projectRoot) });
    const installedDir = join(projectRoot, ".agents", "plugins", "hybrid-tools");

    expect(result.pluginWarnings.map((warning) => warning.message)).toEqual([
      'Plugin "hybrid-tools" is a hybrid compatibility bundle: the portable core remains authoritative; authored native interfaces are retained only as matching-client fallbacks.',
      expect.stringContaining("malformed Claude native fallback that was ignored"),
      'Plugin "hybrid-tools" targets "claude", but "claude" is not listed in agents.',
    ]);
    expect(await readFile(join(installedDir, ".claude-plugin", "plugin.json"), "utf-8")).toBe(malformedBytes);
    expect(existsSync(join(projectRoot, ".claude-plugin", "marketplace.json"))).toBe(false);
  });

  it("prunes only managed target state when a hybrid target is removed", async () => {
    const sourceDir = join(projectRoot, "plugin-source", "hybrid-tools");
    await mkdir(join(sourceDir, ".claude-plugin"), { recursive: true });
    await writeFile(join(sourceDir, "plugin.json"), JSON.stringify({
      $schema: AGENT_PLUGIN_SCHEMA,
      name: "hybrid-tools",
    }));
    const claudeBytes = '{ "name": "hybrid-tools", "metadata": {"managedBy": "dotagents"}, "x-authored": true }\n';
    await writeFile(join(sourceDir, ".claude-plugin", "plugin.json"), claudeBytes);
    await writeFile(join(projectRoot, "agents.toml"), HYBRID_TARGET_CONFIG(["claude", "cursor"]));
    const scope = resolveScope("project", projectRoot);
    await runInstall({ scope });
    const installedDir = join(scope.pluginsDir, "hybrid-tools");
    expect(existsSync(join(projectRoot, ".claude-plugin", "marketplace.json"))).toBe(true);
    expect(existsSync(join(installedDir, ".cursor-plugin", "plugin.json.dotagents-managed"))).toBe(true);

    await writeFile(join(projectRoot, "agents.toml"), HYBRID_TARGET_CONFIG(["cursor"]));
    await runSync({ scope });

    expect(existsSync(join(projectRoot, ".claude-plugin", "marketplace.json"))).toBe(false);
    expect(await readFile(join(installedDir, ".claude-plugin", "plugin.json"), "utf-8")).toBe(claudeBytes);
    expect(existsSync(join(installedDir, ".cursor-plugin", "plugin.json.dotagents-managed"))).toBe(true);
  });

  it("handles source upgrades between managed and authored native manifests", async () => {
    const sourceDir = join(projectRoot, "plugin-source", "hybrid-tools");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "plugin.json"), JSON.stringify({
      $schema: AGENT_PLUGIN_SCHEMA,
      name: "hybrid-tools",
    }));
    await writeFile(join(projectRoot, "agents.toml"), `version = 1
agents = ["claude"]

[[plugins]]
    name = "hybrid-tools"
source = "path:plugin-source/hybrid-tools"
`);
    const scope = resolveScope("project", projectRoot);
    const installedDir = join(scope.pluginsDir, "hybrid-tools");
    const installedManifest = join(installedDir, ".claude-plugin", "plugin.json");

    await runInstall({ scope });
    expect(existsSync(`${installedManifest}.dotagents-managed`)).toBe(true);

    const authoredBytes = '{\n "name": "hybrid-tools", "metadata": {"managedBy": "dotagents"}, "x-authored": true\n}\n';
    await mkdir(join(sourceDir, ".claude-plugin"), { recursive: true });
    await writeFile(join(sourceDir, ".claude-plugin", "plugin.json"), authoredBytes);
    await writeFile(
      join(sourceDir, ".claude-plugin", "plugin.json.dotagents-managed"),
      "managedBy=dotagents\n",
    );
    await runInstall({ scope });
    expect(await readFile(installedManifest, "utf-8")).toBe(authoredBytes);
    expect(existsSync(`${installedManifest}.dotagents-managed`)).toBe(false);
    await runSync({ scope });
    expect(await readFile(installedManifest, "utf-8")).toBe(authoredBytes);

    const nativeSourceMarker = join(installedDir, ".dotagents-native-source");
    await writeFile(nativeSourceMarker, "cursor\n");
    const conflictingProvenance = await runSync({ scope });
    expect(conflictingProvenance.issues.some((issue) =>
      issue.message.includes("conflicting native interface provenance")
    )).toBe(true);
    await rm(nativeSourceMarker);

    await rm(installedManifest);
    const missingAuthored = await runSync({ scope });
    expect(missingAuthored.issues.some((issue) =>
      issue.message.includes("records a Claude native fallback") &&
      issue.message.includes("Reinstall the plugin")
    )).toBe(true);
    expect(existsSync(installedManifest)).toBe(false);
    await runInstall({ scope });
    expect(await readFile(installedManifest, "utf-8")).toBe(authoredBytes);

    const installedRootManifest = join(installedDir, "plugin.json");
    await rm(installedRootManifest);
    const missingCanonical = await runSync({ scope });
    expect(missingCanonical.issues.some((issue) =>
      issue.message.includes("missing plugin.json") && issue.message.includes("Reinstall the plugin")
    )).toBe(true);
    expect(await readFile(installedManifest, "utf-8")).toBe(authoredBytes);
    await runInstall({ scope });

    await rm(join(sourceDir, ".claude-plugin"), { recursive: true });
    await runInstall({ scope });
    expect(JSON.parse(await readFile(installedManifest, "utf-8"))).toMatchObject({ name: "hybrid-tools" });
    expect(existsSync(`${installedManifest}.dotagents-managed`)).toBe(true);

    const unmanagedBytes = '{ "name": "hybrid-tools", "x-unmanaged": true }\n';
    await writeFile(installedManifest, unmanagedBytes);
    await rm(`${installedManifest}.dotagents-managed`, { force: true });
    const sync = await runSync({ scope });
    expect(sync.issues.some((issue) => issue.message.includes("manifest exists and is not managed"))).toBe(true);
    expect(await readFile(installedManifest, "utf-8")).toBe(unmanagedBytes);
  });

  it("imports a native Claude bundle without cross-translating native components", async () => {
    const sourceDir = join(projectRoot, "plugin-source", "claude-tools");
    await mkdir(join(sourceDir, ".claude-plugin"), { recursive: true });
    await mkdir(join(sourceDir, "claude-skills", "portable-qa"), { recursive: true });
    await mkdir(join(sourceDir, "private-skills", "native-only"), { recursive: true });
    await mkdir(join(sourceDir, "commands"), { recursive: true });
    await mkdir(join(sourceDir, "agents"), { recursive: true });
    const nativeManifest = {
      name: "claude-tools",
      version: "1.0.0",
      description: "Claude-native tools",
      skills: ["./claude-skills", "./private-skills"],
      commands: "./commands",
      agents: "./agents",
      mcpServers: "./mcp.json",
    };
    await writeFile(join(sourceDir, ".claude-plugin", "plugin.json"), JSON.stringify(nativeManifest, null, 2));
    await writeFile(join(sourceDir, ".claude-plugin", "plugin.json.dotagents-managed"), "managedBy=dotagents\n");
    const nativeMcp = { mcpServers: { native: { command: "node" } } };
    await writeFile(join(sourceDir, "mcp.json"), JSON.stringify(nativeMcp));
    await writeFile(join(sourceDir, "claude-skills", "portable-qa", "SKILL.md"), SKILL_MD("portable-qa"));
    await writeFile(join(sourceDir, "private-skills", "native-only", "SKILL.md"), SKILL_MD("native-only"));
    await symlink("claude-skills", join(sourceDir, "skills"));
    await writeFile(join(sourceDir, "commands", "native.md"), "native command");
    await writeFile(join(sourceDir, "agents", "native.md"), "native agent");
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1
agents = ["claude", "cursor", "grok", "opencode"]

[[plugins]]
name = "claude-tools"
source = "path:plugin-source/claude-tools"
`,
    );

    const scope = resolveScope("project", projectRoot);
    const result = await runInstall({ scope });
    expect(result.pluginWarnings).toEqual([]);

    const installedDir = join(projectRoot, ".agents", "plugins", "claude-tools");
    expect(await readFile(join(installedDir, ".dotagents-native-source"), "utf-8")).toBe("claude\n");
    expect(JSON.parse(await readFile(join(installedDir, ".claude-plugin", "plugin.json"), "utf-8"))).toEqual(nativeManifest);
    expect(existsSync(join(installedDir, ".claude-plugin", "plugin.json.dotagents-managed"))).toBe(false);
    expect(await readFile(join(installedDir, "commands", "native.md"), "utf-8")).toBe("native command");
    expect(await readFile(join(installedDir, "agents", "native.md"), "utf-8")).toBe("native agent");
    expect(JSON.parse(await readFile(join(installedDir, "mcp.json"), "utf-8"))).toEqual(nativeMcp);

    const cursorManifest = JSON.parse(await readFile(join(installedDir, ".cursor-plugin", "plugin.json"), "utf-8"));
    expect(cursorManifest).toEqual({
      description: "Claude-native tools",
      name: "claude-tools",
      skills: "./skills",
      version: "1.0.0",
    });
    expect(existsSync(join(projectRoot, ".opencode", "skills", "portable-qa"))).toBe(true);
    expect(existsSync(join(projectRoot, ".opencode", "skills", "native-only"))).toBe(false);
    expect(existsSync(join(projectRoot, ".opencode", "agents", "native.md"))).toBe(false);
    await expectHarnessFiles(projectRoot, [".grok/plugins/claude-tools"], {
      ".grok/plugins/claude-tools/.dotagents-managed": { text: "Generated by dotagents. Do not edit.\n" },
      ".grok/plugins/claude-tools/plugin.json": { json: {
        $schema: AGENT_PLUGIN_SCHEMA,
        description: "Claude-native tools",
        name: "claude-tools",
        version: "1.0.0",
      } },
      ".grok/plugins/claude-tools/skills/portable-qa/SKILL.md": { text: SKILL_MD("portable-qa") },
    });

    await runSync({ scope });
    expect(await readFile(join(installedDir, ".dotagents-native-source"), "utf-8")).toBe("claude\n");
    expect(JSON.parse(await readFile(join(installedDir, ".claude-plugin", "plugin.json"), "utf-8"))).toEqual(nativeManifest);
    expect(JSON.parse(await readFile(join(installedDir, ".cursor-plugin", "plugin.json"), "utf-8"))).toEqual(cursorManifest);
    expect(await readFile(join(installedDir, "commands", "native.md"), "utf-8")).toBe("native command");
    expect(await readFile(join(installedDir, "agents", "native.md"), "utf-8")).toBe("native agent");
    expect(JSON.parse(await readFile(join(installedDir, "mcp.json"), "utf-8"))).toEqual(nativeMcp);
  });
  it("reports a plugin destination file as unmanaged", async () => {
    const sourceDir = join(projectRoot, "plugin-source", "review-tools");
    await mkdir(join(sourceDir, "skills", "review"), { recursive: true });
    await writeFile(join(sourceDir, "plugin.json"), JSON.stringify({ name: "review-tools" }, null, 2));
    await writeFile(join(sourceDir, "skills", "review", "SKILL.md"), SKILL_MD("review"));
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1
agents = ["codex"]

[[plugins]]
name = "review-tools"
source = "path:plugin-source/review-tools"
`,
    );
    await mkdir(join(projectRoot, ".agents", "plugins"), { recursive: true });
    await writeFile(join(projectRoot, ".agents", "plugins", "review-tools"), "owned by user\n");

    await expect(runInstallCommand({ scope: resolveScope("project", projectRoot) }))
      .rejects.toThrow(/install destination already exists and is not managed/);
  });

  it.each(["directory", "wrong-content file"] as const)(
    "does not overwrite an existing plugin destination with an unmanaged marker %s",
    async (markerShape) => {
    const sourceDir = join(projectRoot, "plugin-source", "review-tools");
    await mkdir(join(sourceDir, "skills", "review"), { recursive: true });
    await writeFile(join(sourceDir, "plugin.json"), JSON.stringify({ name: "review-tools" }, null, 2));
    await writeFile(join(sourceDir, "skills", "review", "SKILL.md"), SKILL_MD("review"));

    const existingDir = join(projectRoot, ".agents", "plugins", "review-tools");
    await mkdir(existingDir, { recursive: true });
    if (markerShape === "directory") {
      await mkdir(join(existingDir, DOTAGENTS_MANAGED_PLUGIN_MARKER));
    } else {
      await writeFile(join(existingDir, DOTAGENTS_MANAGED_PLUGIN_MARKER), "owned-by=user\n");
    }
    await writeFile(join(existingDir, "plugin.json"), JSON.stringify({ name: "review-tools", description: "Hand written" }, null, 2));
    await writeLockfile(join(projectRoot, "agents.lock"), {
      version: 1,
      skills: {},
      subagents: {},
      plugins: {
        "review-tools": { source: "path:plugin-source/review-tools" },
      },
    });

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
    await expect(runInstall({ scope })).rejects.toThrow(/install destination already exists and is not managed/);

    const existingManifest = JSON.parse(await readFile(join(existingDir, "plugin.json"), "utf-8")) as SerializedObject;
    expect(existingManifest["description"]).toBe("Hand written");
    },
  );

  it("prunes dangling component links for stale managed plugins whose bundles are already missing", async () => {
    const linkDir = join(projectRoot, ".opencode", "skills");
    const linkPath = join(linkDir, "old-plugin-skill");
    await mkdir(linkDir, { recursive: true });
    await symlink(
      relative(linkDir, join(projectRoot, ".agents", "plugins", "old-tools", "skills", "old-plugin-skill")),
      linkPath,
    );
    await writeFile(join(projectRoot, "agents.toml"), `version = 1\nagents = ["opencode"]\n`);
    await writeLockfile(join(projectRoot, "agents.lock"), {
      version: 1,
      skills: {},
      subagents: {},
      plugins: {
        "old-tools": { source: "org/old-tools" },
      },
    });

    await runInstall({ scope: resolveScope("project", projectRoot) });

    expect(existsSync(linkPath)).toBe(false);
  });

  it("does not treat malformed lockfile plugin names as managed projection roots", async () => {
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
      subagents: {},
      plugins: {
        "../../outside": { source: "org/old-tools" },
      },
    });

    await runInstall({ scope: resolveScope("project", projectRoot) });

    expect(existsSync(linkPath)).toBe(true);
    expect(await readFile(join(outsideSkillDir, "SKILL.md"), "utf-8")).toBe(SKILL_MD("keep"));
    expect((await loadLockfile(join(projectRoot, "agents.lock")))!.plugins).toEqual({});
  });

  it("rejects escaping plugin symlinks before writing Grok projections", async () => {
    const sourceDir = join(projectRoot, "plugin-source", "review-tools");
    const outsideFile = join(projectRoot, "secret.txt");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "plugin.json"), JSON.stringify({ name: "review-tools" }, null, 2));
    await writeFile(outsideFile, "secret\n");
    await symlink(outsideFile, join(sourceDir, "secret-link"));
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1
agents = ["grok"]

[[plugins]]
name = "review-tools"
source = "path:plugin-source/review-tools"
`,
    );

    await expect(runInstall({ scope: resolveScope("project", projectRoot) }))
      .rejects.toThrow(/symlink resolves outside the plugin directory/);

    expect(existsSync(join(projectRoot, ".agents", "plugins", "review-tools"))).toBe(false);
    expect(existsSync(join(projectRoot, ".grok", "plugins", "review-tools"))).toBe(false);
  });

  it("overwrites an existing managed plugin install destination", async () => {
    const sourceDir = join(projectRoot, "plugin-source", "review-tools");
    await mkdir(join(sourceDir, "skills", "review"), { recursive: true });
    await writeFile(
      join(sourceDir, "plugin.json"),
      JSON.stringify({ name: "review-tools", description: "Updated plugin" }, null, 2),
    );
    await writeFile(join(sourceDir, "skills", "review", "SKILL.md"), SKILL_MD("review"));

    const existingDir = join(projectRoot, ".agents", "plugins", "review-tools");
    await mkdir(join(existingDir, "skills", "old-review"), { recursive: true });
    await writeFile(
      join(existingDir, "plugin.json"),
      JSON.stringify({ name: "review-tools", description: "Old managed plugin" }, null, 2),
    );
    await writeFile(join(existingDir, DOTAGENTS_MANAGED_PLUGIN_MARKER), "managedBy=dotagents\n", "utf-8");
    await writeFile(join(existingDir, "skills", "old-review", "SKILL.md"), SKILL_MD("old-review"));
    await writeLockfile(join(projectRoot, "agents.lock"), {
      version: 1,
      skills: {},
      subagents: {},
      plugins: {
        "review-tools": { source: "path:plugin-source/review-tools" },
      },
    });

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
    await runInstall({ scope });

    const installedManifest = JSON.parse(await readFile(join(existingDir, "plugin.json"), "utf-8")) as SerializedObject;
    expect(installedManifest["description"]).toBe("Updated plugin");
    expect(existsSync(join(existingDir, "skills", "review", "SKILL.md"))).toBe(true);
    expect(existsSync(join(existingDir, "skills", "old-review", "SKILL.md"))).toBe(false);
  });

  it("recovers a dotagents-managed plugin destination missing from the lockfile", async () => {
    const sourceDir = join(projectRoot, "plugin-source", "review-tools");
    await mkdir(join(sourceDir, "skills", "review"), { recursive: true });
    await writeFile(
      join(sourceDir, "plugin.json"),
      JSON.stringify({ name: "review-tools", description: "Recovered plugin" }, null, 2),
    );
    await writeFile(join(sourceDir, "skills", "review", "SKILL.md"), SKILL_MD("review"));

    const existingDir = join(projectRoot, ".agents", "plugins", "review-tools");
    await mkdir(join(existingDir, "skills", "partial"), { recursive: true });
    await writeFile(join(existingDir, DOTAGENTS_MANAGED_PLUGIN_MARKER), "managedBy=dotagents\n", "utf-8");
    await writeFile(join(existingDir, "skills", "partial", "SKILL.md"), SKILL_MD("partial"));

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
    await runInstall({ scope });

    const installedManifest = JSON.parse(await readFile(join(existingDir, "plugin.json"), "utf-8")) as SerializedObject;
    expect(installedManifest["description"]).toBe("Recovered plugin");
    expect(existsSync(join(existingDir, "skills", "review", "SKILL.md"))).toBe(true);
    expect(existsSync(join(existingDir, "skills", "partial", "SKILL.md"))).toBe(false);
  });

  it("does not overwrite an unmarked in-place plugin when its source moves external", async () => {
    const sourceDir = join(projectRoot, "plugin-source", "review-tools");
    await mkdir(join(sourceDir, "skills", "review"), { recursive: true });
    await writeFile(
      join(sourceDir, "plugin.json"),
      JSON.stringify({ name: "review-tools", description: "External plugin" }, null, 2),
    );
    await writeFile(join(sourceDir, "skills", "review", "SKILL.md"), SKILL_MD("review"));

    const existingDir = join(projectRoot, ".agents", "plugins", "review-tools");
    await mkdir(existingDir, { recursive: true });
    await writeFile(join(existingDir, "plugin.json"), JSON.stringify({ name: "review-tools", description: "In-place plugin" }, null, 2));
    await writeLockfile(join(projectRoot, "agents.lock"), {
      version: 1,
      skills: {},
      subagents: {},
      plugins: {
        "review-tools": { source: "path:.agents/plugins/review-tools" },
      },
    });

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
    await expect(runInstall({ scope })).rejects.toThrow(/install destination already exists and is not managed/);

    const installedManifest = JSON.parse(await readFile(join(existingDir, "plugin.json"), "utf-8")) as SerializedObject;
    expect(installedManifest["description"]).toBe("In-place plugin");
    const lockfile = await loadLockfile(join(projectRoot, "agents.lock"));
    expect(lockfile!.plugins["review-tools"]).toEqual({
      source: "path:.agents/plugins/review-tools",
    });
  });

  it("does not gitignore in-place skills that collide with Pi plugin projections", async () => {
    await mkdir(join(projectRoot, ".agents", "skills", "review"), { recursive: true });
    await writeFile(join(projectRoot, ".agents", "skills", "review", "SKILL.md"), SKILL_MD("review"));

    const sourceDir = join(projectRoot, "plugin-source", "review-tools");
    await mkdir(join(sourceDir, "skills", "review"), { recursive: true });
    await writeFile(join(sourceDir, "plugin.json"), JSON.stringify({ name: "review-tools" }, null, 2));
    await writeFile(join(sourceDir, "skills", "review", "SKILL.md"), SKILL_MD("review"));
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1
agents = ["pi"]

[[skills]]
name = "review"
source = "path:.agents/skills/review"

[[plugins]]
name = "review-tools"
source = "path:plugin-source/review-tools"
`,
    );

    const scope = resolveScope("project", projectRoot);
    const result = await runInstall({ scope });

    expect(result.pluginWarnings).toEqual([
      {
        agent: "pi",
        name: "review-tools",
        message: `Pi plugin skill projection exists and is not managed by dotagents: ${join(projectRoot, ".agents", "skills", "review")}`,
      },
    ]);
    const agentsGitignore = await readFile(join(projectRoot, ".agents", ".gitignore"), "utf-8");
    expect(agentsGitignore).not.toContain("/skills/review");
    expect(agentsGitignore).toContain("/plugins/review-tools/");
  });

  it("does not gitignore orphan skills that collide with Pi plugin projections", async () => {
    await mkdir(join(projectRoot, ".agents", "skills", "review"), { recursive: true });
    await writeFile(join(projectRoot, ".agents", "skills", "review", "SKILL.md"), SKILL_MD("review"));

    const sourceDir = join(projectRoot, "plugin-source", "review-tools");
    await mkdir(join(sourceDir, "skills", "review"), { recursive: true });
    await writeFile(join(sourceDir, "plugin.json"), JSON.stringify({ name: "review-tools" }, null, 2));
    await writeFile(join(sourceDir, "skills", "review", "SKILL.md"), SKILL_MD("review"));
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1
agents = ["pi"]

[[plugins]]
name = "review-tools"
source = "path:plugin-source/review-tools"
`,
    );

    const scope = resolveScope("project", projectRoot);
    const result = await runInstall({ scope });

    expect(result.pluginWarnings).toEqual([
      {
        agent: "pi",
        name: "review-tools",
        message: `Pi plugin skill projection exists and is not managed by dotagents: ${join(projectRoot, ".agents", "skills", "review")}`,
      },
    ]);
    const agentsGitignore = await readFile(join(projectRoot, ".agents", ".gitignore"), "utf-8");
    expect(agentsGitignore).not.toContain("/skills/review");
    expect(agentsGitignore).toContain("/plugins/review-tools/");
  });

  it("installs a plugin from a git source and records resolved lock metadata", async () => {
    await ensureGitRepo();
    const pluginDir = join(repoDir, "plugins", "review-tools");
    await mkdir(join(pluginDir, "skills", "review"), { recursive: true });
    await writeFile(
      join(pluginDir, "plugin.json"),
      JSON.stringify({
        name: "review-tools",
        description: "Review workflow helpers",
      }, null, 2),
    );
    await writeFile(join(pluginDir, "skills", "review", "SKILL.md"), SKILL_MD("review"));
    await exec("git", ["add", "."], { cwd: repoDir });
    await exec("git", ["commit", "-m", "add review plugin"], { cwd: repoDir });
    const { stdout: commit } = await exec("git", ["rev-parse", "HEAD"], { cwd: repoDir });

    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1
agents = ["codex"]

[[plugins]]
name = "review-tools"
source = "git:${repoDir}"
path = "plugins/review-tools"
`,
    );

    const scope = resolveScope("project", projectRoot);
    await runInstall({ scope });

    expect(existsSync(join(projectRoot, ".agents", "plugins", "review-tools", "skills", "review", "SKILL.md"))).toBe(true);
    expect(existsSync(join(projectRoot, ".agents", "plugins", "review-tools", ".codex-plugin", "plugin.json"))).toBe(true);

    const lockfile = await loadLockfile(join(projectRoot, "agents.lock"));
    expect(lockfile!.plugins["review-tools"]).toEqual({
      source: `git:${repoDir}`,
      resolved_url: repoDir,
      resolved_path: "plugins/review-tools",
      resolved_commit: commit.trim(),
    });
  });

  it("rejects an explicit plugin path without a manifest", async () => {
    const sourceDir = join(projectRoot, "plugin-source", "review-tools-v2");
    await mkdir(join(sourceDir, "skills", "review"), { recursive: true });
    await writeFile(join(sourceDir, "skills", "review", "SKILL.md"), SKILL_MD("review"));
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1
agents = ["codex"]

[[plugins]]
name = "review-tools"
source = "path:."
path = "plugin-source/review-tools-v2"
`,
    );

    const scope = resolveScope("project", projectRoot);
    await expect(runInstall({ scope })).rejects.toThrow('Plugin "review-tools" not found');
    expect(existsSync(join(projectRoot, ".agents", "plugins", "review-tools"))).toBe(false);
  });

  it("rejects an explicit plugin path when its manifest name differs", async () => {
    const sourceDir = join(projectRoot, "plugin-source", "review-tools-v2");
    await mkdir(join(sourceDir, "skills", "review"), { recursive: true });
    await writeFile(join(sourceDir, "skills", "review", "SKILL.md"), SKILL_MD("review"));
    await writeFile(
      join(sourceDir, "plugin.json"),
      JSON.stringify({ name: "other-tools", description: "Wrong plugin" }, null, 2),
    );
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1
agents = ["codex"]

[[plugins]]
name = "review-tools"
source = "path:."
path = "plugin-source/review-tools-v2"
`,
    );

    const scope = resolveScope("project", projectRoot);
    await expect(runInstall({ scope })).rejects.toThrow(
      'Plugin manifest name "other-tools" does not match configured name "review-tools"',
    );
    expect(existsSync(join(projectRoot, ".agents", "plugins", "review-tools"))).toBe(false);
  });

  it("prefers plugin directory-name matches over root manifest-name matches", async () => {
    const sourceRoot = join(projectRoot, "plugin-source");
    const pluginDir = join(sourceRoot, "plugins", "review-tools");
    await mkdir(join(sourceRoot, "skills", "root-review"), { recursive: true });
    await mkdir(join(pluginDir, "skills", "review"), { recursive: true });
    await writeFile(
      join(sourceRoot, "plugin.json"),
      JSON.stringify({ name: "review-tools", description: "Root plugin should not win" }, null, 2),
    );
    await writeFile(
      join(pluginDir, "plugin.json"),
      JSON.stringify({ name: "review-tools", description: "Directory plugin" }, null, 2),
    );
    await writeFile(join(sourceRoot, "skills", "root-review", "SKILL.md"), SKILL_MD("root-review"));
    await writeFile(join(pluginDir, "skills", "review", "SKILL.md"), SKILL_MD("review"));
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

    expect(existsSync(join(projectRoot, ".agents", "plugins", "review-tools", "skills", "review", "SKILL.md"))).toBe(true);
    expect(existsSync(join(projectRoot, ".agents", "plugins", "review-tools", "skills", "root-review", "SKILL.md"))).toBe(false);
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

  it("installs user-scope plugins and writes global runtime projections", async () => {
    const previousHome = process.env["DOTAGENTS_HOME"];
    const previousOsHome = process.env["HOME"];
    const dotagentsHome = join(tmpDir, "user-agents");
    const userHome = join(tmpDir, "home");
    process.env["DOTAGENTS_HOME"] = dotagentsHome;
    process.env["HOME"] = userHome;
    try {
      const scope = resolveScope("user");
      const sourceDir = join(scope.root, "plugin-source", "review-tools");
      await mkdir(join(sourceDir, "skills", "review"), { recursive: true });
      await writeFile(
        join(sourceDir, "plugin.json"),
        JSON.stringify({
          $schema: AGENT_PLUGIN_SCHEMA,
          name: "review-tools",
          version: "1.0.0",
        }),
      );
      await writeFile(join(sourceDir, "mcp.json"), JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
        mcpServers: {
          sentry: {
            type: "streamable-http",
            url: "https://mcp.sentry.dev/mcp",
          },
        },
      }));
      await writeFile(join(sourceDir, "skills", "review", "SKILL.md"), SKILL_MD("review"));
      await writeFile(
        scope.configPath,
        `version = 1
agents = ["claude", "codex", "opencode", "pi"]

[[plugins]]
name = "review-tools"
source = "path:plugin-source/review-tools"
`,
      );

      const result = await runInstall({ scope });
      expect(result.installedPlugins).toEqual(["review-tools"]);
      expect(existsSync(join(scope.pluginsDir, "review-tools", "plugin.json"))).toBe(true);
      expect(existsSync(join(scope.root, ".claude-plugin", "marketplace.json"))).toBe(true);
      expect(existsSync(join(scope.root, ".agents", "plugins", "marketplace.json"))).toBe(true);
      expect(await readlink(join(scope.skillsDir, "review"))).toBe("../plugins/review-tools/skills/review");
      expect(await readlink(join(userHome, ".config", "opencode", "skills", "review"))).toContain(
        join("user-agents", "plugins", "review-tools", "skills", "review"),
      );
      expect(JSON.parse(await readFile(
        join(userHome, ".config", "opencode", "opencode.json"),
        "utf-8",
      ))).toMatchObject({
        mcp: {
          "plugin.review-tools.sentry": {
            type: "remote",
            url: "https://mcp.sentry.dev/mcp",
          },
        },
      });
      expect(JSON.parse(await readFile(
        join(scope.root, "plugin-mcp", "opencode.json"),
        "utf-8",
      ))).toEqual({
        version: 1,
        servers: ["plugin.review-tools.sentry"],
      });
    } finally {
      if (previousHome === undefined) {
        delete process.env["DOTAGENTS_HOME"];
      } else {
        process.env["DOTAGENTS_HOME"] = previousHome;
      }
      if (previousOsHome === undefined) {
        delete process.env["HOME"];
      } else {
        process.env["HOME"] = previousOsHome;
      }
    }
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
    ) as SerializedObject;
    expect(installed["description"]).toBe("Canonical plugin");
  });

  it("does not overlay marketplace fields onto standard manifests", async () => {
    const sourceRoot = join(projectRoot, "plugin-source");
    const pluginDir = join(sourceRoot, "plugins", "review-tools");
    await mkdir(join(pluginDir, "skills", "review"), { recursive: true });
    await writeFile(join(pluginDir, "skills", "review", "SKILL.md"), SKILL_MD("review"));
    const sourceManifest = {
      $schema: AGENT_PLUGIN_SCHEMA,
      name: "review-tools",
      description: "Source description",
      version: "2.0.0",
    };
    await writeFile(join(pluginDir, "plugin.json"), JSON.stringify(sourceManifest, null, 2));
    await writeFile(
      join(sourceRoot, "marketplace.json"),
      JSON.stringify({
        name: "test-marketplace",
        plugins: [
          {
            name: "review-tools",
            source: { source: "local", path: "plugins/review-tools" },
            description: "Marketplace description",
            version: "1.0.0",
            category: "Coding",
            policy: { installation: "AVAILABLE" },
            "x-marketplace": true,
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

    const installedManifest = JSON.parse(
      await readFile(join(projectRoot, ".agents", "plugins", "review-tools", "plugin.json"), "utf-8"),
    ) as SerializedObject;
    const codexManifest = JSON.parse(
      await readFile(join(projectRoot, ".agents", "plugins", "review-tools", ".codex-plugin", "plugin.json"), "utf-8"),
    ) as SerializedObject;

    expect(installedManifest).toEqual(sourceManifest);
    expect(codexManifest["description"]).toBe("Source description");
    expect(codexManifest["version"]).toBe("2.0.0");
    expect(codexManifest["category"]).toBeUndefined();
    expect(installedManifest["source"]).toBeUndefined();
    expect(installedManifest["policy"]).toBeUndefined();
    expect(installedManifest["x-marketplace"]).toBeUndefined();
    expect(codexManifest["source"]).toBeUndefined();
    expect(codexManifest["policy"]).toBeUndefined();
    expect(codexManifest["x-marketplace"]).toBeUndefined();
  });

  it("resolves canonical marketplace sources relative to the marketplace directory", async () => {
    const sourceRoot = join(projectRoot, "plugin-source");
    const pluginDir = join(sourceRoot, ".agents", "plugins", "review-tools");
    await mkdir(join(pluginDir, "skills", "review"), { recursive: true });
    await writeFile(join(pluginDir, "skills", "review", "SKILL.md"), SKILL_MD("review"));
    await writeFile(
      join(pluginDir, "plugin.json"),
      JSON.stringify({ name: "review-tools", description: "Canonical marketplace plugin" }, null, 2),
    );
    await writeFile(
      join(sourceRoot, ".agents", "plugins", "marketplace.json"),
      JSON.stringify({
        name: "source-marketplace",
        plugins: [
          {
            name: "review-tools",
            source: { source: "local", path: "./review-tools" },
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

    const installedManifest = JSON.parse(
      await readFile(join(projectRoot, ".agents", "plugins", "review-tools", "plugin.json"), "utf-8"),
    ) as SerializedObject;
    expect(installedManifest["description"]).toBe("Canonical marketplace plugin");
  });

  it("skips unsupported marketplace source objects during plugin discovery", async () => {
    const sourceRoot = join(projectRoot, "plugin-source");
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(
      join(sourceRoot, "marketplace.json"),
      JSON.stringify({
        name: "source-marketplace",
        plugins: [
          {
            name: "review-tools",
            source: {
              source: "github",
              path: "external/marketplace-review-tools",
              repo: "org/review-tools",
            },
          },
        ],
      }, null, 2),
    );
    const marketplaceOnlyDir = join(sourceRoot, "external", "marketplace-review-tools");
    await mkdir(marketplaceOnlyDir, { recursive: true });
    await writeFile(
      join(marketplaceOnlyDir, "plugin.json"),
      JSON.stringify({
        name: "review-tools",
        description: "Marketplace-only plugin",
      }, null, 2),
    );
    const pluginDir = join(sourceRoot, "plugins", "review-tools");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      join(pluginDir, "plugin.json"),
      JSON.stringify({
        name: "review-tools",
        description: "Fallback local plugin",
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

    const installedManifest = JSON.parse(
      await readFile(join(projectRoot, ".agents", "plugins", "review-tools", "plugin.json"), "utf-8"),
    ) as SerializedObject;
    expect(installedManifest["description"]).toBe(
      "Fallback local plugin",
    );
  });

  it("skips malformed marketplace files during plugin discovery", async () => {
    const sourceRoot = join(projectRoot, "plugin-source");
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(
      join(sourceRoot, "marketplace.json"),
      JSON.stringify({
        name: "source-marketplace",
        plugins: [
          {
            name: "review-tools",
            source: { source: "local" },
          },
        ],
      }, null, 2),
    );
    const pluginDir = join(sourceRoot, "plugins", "review-tools");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      join(pluginDir, "plugin.json"),
      JSON.stringify({
        name: "review-tools",
        description: "Fallback local plugin",
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

    const installedManifest = JSON.parse(
      await readFile(join(projectRoot, ".agents", "plugins", "review-tools", "plugin.json"), "utf-8"),
    ) as SerializedObject;
    expect(installedManifest["description"]).toBe("Fallback local plugin");
  });

  it("reports unsupported marketplace source objects when no compatible plugin is found", async () => {
    const sourceRoot = join(projectRoot, "plugin-source");
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(
      join(sourceRoot, "marketplace.json"),
      JSON.stringify({
        name: "source-marketplace",
        plugins: [
          {
            name: "review-tools",
            source: {
              source: "github",
              path: "external/marketplace-review-tools",
              repo: "org/review-tools",
            },
          },
        ],
      }, null, 2),
    );
    const marketplaceOnlyDir = join(sourceRoot, "external", "marketplace-review-tools");
    await mkdir(marketplaceOnlyDir, { recursive: true });
    await writeFile(
      join(marketplaceOnlyDir, "plugin.json"),
      JSON.stringify({
        name: "review-tools",
        description: "Marketplace-only plugin",
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
    await expect(runInstall({ scope })).rejects.toThrow(
      /Matching marketplace entries use unsupported source types: github/,
    );
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
    const result = await runInstall({ scope });

    const mcp = JSON.parse(await readFile(join(projectRoot, ".mcp.json"), "utf-8"));
    expect(mcp.mcpServers.github).toBeDefined();
    expect(result.mcpWarnings).toEqual([]);

    // Agent symlinks should also be created
    const stat = await lstat(join(projectRoot, ".claude", "skills"));
    expect(stat.isSymbolicLink()).toBe(true);
  });

  it("preserves a pre-existing MCP config when no servers are declared", async () => {
    const configPath = join(projectRoot, "agents.toml");
    const mcpPath = join(projectRoot, ".mcp.json");
    const content = JSON.stringify({
      editor: "manual",
      mcpServers: { manual: { command: "manual" } },
    });
    await writeFile(configPath, `version = 1\nagents = ["claude"]\n`);
    await writeFile(mcpPath, content);

    const scope = resolveScope("project", projectRoot);
    await runInstall({ scope });

    expect(await readFile(mcpPath, "utf-8")).toBe(content);
  });

  it("warns without changing an incompatible MCP config", async () => {
    const configPath = join(projectRoot, "agents.toml");
    const mcpPath = join(projectRoot, ".mcp.json");
    const content = '{"mcpServers":[]}\n';
    await writeFile(
      configPath,
      `version = 1\nagents = ["claude"]\n\n[[mcp]]\nname = "github"\ncommand = "github-mcp"\n`,
    );
    await writeFile(mcpPath, content);

    const result = await runInstall({ scope: resolveScope("project", projectRoot) });

    expect(result.mcpWarnings).toEqual([{
      agent: "claude",
      message: `Failed to read MCP config: ${mcpPath}`,
    }]);
    expect(await readFile(mcpPath, "utf-8")).toBe(content);
  });

  it("accepts --frozen as a warned normal install", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "pdf"\nsource = "git:${repoDir}"\n`,
    );
    await ensureGitRepo();

    const previousCwd = process.cwd();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    let output = "";
    try {
      process.chdir(projectRoot);
      await install(["--frozen"], { scope: resolveScope("project", projectRoot) });
    } finally {
      output = log.mock.calls.flat().join("\n");
      process.chdir(previousCwd);
      log.mockRestore();
    }

    expect(output).toContain(
      "--frozen is ignored and will be removed in the next major release",
    );
    expect(existsSync(join(projectRoot, ".agents", "skills", "pdf", "SKILL.md"))).toBe(true);
    const lockfile = await loadLockfile(join(projectRoot, "agents.lock"));
    expect(lockfile?.skills["pdf"]).toBeDefined();
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

  it("leaves project-owned Claude hooks unchanged when no hooks are declared", async () => {
    const settingsDir = join(projectRoot, ".claude");
    const settingsPath = join(settingsDir, "settings.json");
    await mkdir(settingsDir, { recursive: true });
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\nagents = ["claude", "codex"]\n`,
    );
    const content = JSON.stringify({
      hooks: {
        SessionStart: [{
          matcher: "startup",
          hooks: [{
            type: "command",
            command: '"$CLAUDE_PROJECT_DIR"/.claude/worktree-setup.sh',
            timeout: 900,
          }],
        }],
      },
    }, null, 2);
    await writeFile(settingsPath, content);

    await runInstall({ scope: resolveScope("project", projectRoot) });

    expect(await readFile(settingsPath, "utf-8")).toBe(content);
  });

  it("reconciles hook drift and preserves generated hook state when declarations are removed", async () => {
    const configPath = join(projectRoot, "agents.toml");
    const claudePath = join(projectRoot, ".claude", "settings.json");
    const cursorPath = join(projectRoot, ".cursor", "hooks.json");
    await mkdir(join(projectRoot, ".claude"), { recursive: true });
    await mkdir(join(projectRoot, ".cursor"), { recursive: true });
    await writeFile(
      configPath,
      `version = 1\nagents = ["claude", "cursor"]\n\n[[hooks]]\nevent = "Stop"\ncommand = "check.sh"\n`,
    );
    await writeFile(claudePath, JSON.stringify({
      permissions: { allow: ["Read"] },
      hooks: { Stop: [{ hooks: [{ type: "command", command: "old.sh" }] }] },
    }));
    await writeFile(cursorPath, JSON.stringify({
      version: 2,
      hooks: { stop: [{ command: "old.sh" }] },
    }));

    const scope = resolveScope("project", projectRoot);
    await runInstall({ scope });
    expect(JSON.parse(await readFile(claudePath, "utf-8"))).toEqual({
      permissions: { allow: ["Read"] },
      hooks: { Stop: [{ hooks: [{ type: "command", command: "check.sh" }] }] },
    });
    expect(JSON.parse(await readFile(cursorPath, "utf-8"))).toEqual({
      version: 1,
      hooks: { stop: [{ command: "check.sh" }] },
    });

    await writeFile(configPath, `version = 1\nagents = ["claude", "cursor"]\n`);
    await runInstall({ scope });
    expect(JSON.parse(await readFile(claudePath, "utf-8"))).toEqual({
      permissions: { allow: ["Read"] },
      hooks: { Stop: [{ hooks: [{ type: "command", command: "check.sh" }] }] },
    });
    expect(JSON.parse(await readFile(cursorPath, "utf-8"))).toEqual({
      version: 1,
      hooks: { stop: [{ command: "check.sh" }] },
    });
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

  it("keeps resolved lock entries when installed subagent writes fail", async () => {
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
    expect(gitignore).toContain("/skills/pdf");
    // In-place skill should NOT be gitignored
    expect(gitignore).not.toContain("/skills/local-skill");
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

  it("installs only wildcard skills under path", async () => {
    await ensureGitRepo();
    await mkdir(join(repoDir, "skills", "engineering", "deploy"), { recursive: true });
    await writeFile(
      join(repoDir, "skills", "engineering", "deploy", "SKILL.md"),
      SKILL_MD("deploy"),
    );
    await mkdir(join(repoDir, "skills", "productivity", "notes"), { recursive: true });
    await writeFile(
      join(repoDir, "skills", "productivity", "notes", "SKILL.md"),
      SKILL_MD("notes"),
    );
    await exec("git", ["add", "."], { cwd: repoDir });
    await exec("git", ["commit", "-m", "add categorized skills"], { cwd: repoDir });
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "*"\nsource = "git:${repoDir}"\npath = "skills/engineering"\n`,
    );

    const result = await runInstall({ scope: resolveScope("project", projectRoot) });

    expect(result.installed).toContain("deploy");
    expect(result.installed).not.toContain("pdf");
    expect(result.installed).not.toContain("notes");
    expect(existsSync(join(projectRoot, ".agents", "skills", "deploy", "SKILL.md"))).toBe(true);
    expect(existsSync(join(projectRoot, ".agents", "skills", "pdf"))).toBe(false);
    expect(existsSync(join(projectRoot, ".agents", "skills", "notes"))).toBe(false);

    const lockfile = await loadLockfile(join(projectRoot, "agents.lock"));
    expect(lockfile!.skills["deploy"]).toEqual(expect.objectContaining({
      resolved_path: "skills/engineering/deploy",
    }));
  });

  it("records resolved paths for scoped local wildcards", async () => {
    const localSkillDir = join(projectRoot, "local-skills", "engineering", "review");
    await mkdir(localSkillDir, { recursive: true });
    await writeFile(join(localSkillDir, "SKILL.md"), SKILL_MD("review"));
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "*"\nsource = "path:local-skills"\npath = "engineering"\n`,
    );

    await runInstall({ scope: resolveScope("project", projectRoot) });

    const lockfile = await loadLockfile(join(projectRoot, "agents.lock"));
    expect(lockfile!.skills["review"]).toEqual({
      source: "path:local-skills",
      resolved_path: "engineering/review",
    });
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

  it("wildcard-expanded skills are gitignored", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "*"\nsource = "git:${repoDir}"\n`,
    );

    const scope = resolveScope("project", projectRoot);
    await runInstall({ scope });

    const gitignore = await readFile(join(projectRoot, ".agents", ".gitignore"), "utf-8");
    expect(gitignore).toContain("/skills/pdf");
    expect(gitignore).toContain("/skills/review");
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

  it("wildcard with all skills excluded installs nothing from that source", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "*"\nsource = "git:${repoDir}"\nexclude = ["pdf", "review"]\n`,
    );

    const scope = resolveScope("project", projectRoot);
    const result = await runInstall({ scope });
    expect(result.installed).toHaveLength(0);
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
