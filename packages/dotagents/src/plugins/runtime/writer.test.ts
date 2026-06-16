import { existsSync } from "node:fs";
import { lstat, mkdtemp, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PluginDeclaration } from "../store.js";
import {
  prunePluginOutputs,
  projectedPiSkillNames,
  verifyPluginOutputs,
  writePluginOutputs,
} from "./writer.js";

describe("plugin writer", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "dotagents-plugin-writer-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true });
  });

  async function plugin(
    name: string,
    overrides: Partial<PluginDeclaration> = {},
  ): Promise<PluginDeclaration> {
    const pluginDir = join(root, ".agents", "plugins", name);
    await mkdir(join(pluginDir, "skills"), { recursive: true });
    await mkdir(join(pluginDir, "commands"), { recursive: true });
    await mkdir(join(pluginDir, "agents"), { recursive: true });
    return {
      name,
      source: `path:.agents/plugins/${name}`,
      pluginDir,
      manifest: {
        name,
        version: "1.0.0",
        description: `Tools for ${name}`,
        category: "Coding",
        author: { name: "Sentry" },
        ...overrides.manifest,
      },
      targets: overrides.targets,
    };
  }

  async function expectSymlinkTarget(linkPath: string, expectedTarget: string): Promise<void> {
    expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
    expect(resolve(dirname(linkPath), await readlink(linkPath))).toBe(resolve(expectedTarget));
  }

  async function writePluginSkill(pluginDir: string, name: string): Promise<void> {
    await mkdir(join(pluginDir, "skills", name), { recursive: true });
    await writeFile(
      join(pluginDir, "skills", name, "SKILL.md"),
      `---\nname: ${name}\ndescription: Plugin QA\n---\n`,
      "utf-8",
    );
  }

  it("writes deterministic marketplace outputs for runtimes that need projections", async () => {
    const alpha = await plugin("alpha-tools");
    const beta = await plugin("beta-tools");

    const result = await writePluginOutputs(
      ["cursor", "codex", "claude"],
      [beta, alpha],
      root,
    );

    expect(result.warnings).toEqual([]);
    expect(result.written).toBe(9);
    const codexMarketplace = JSON.parse(await readFile(join(root, ".agents", "plugins", "marketplace.json"), "utf-8")) as Record<string, unknown>;
    expect(codexMarketplace).toEqual({
      interface: {
        displayName: "Dotagents Plugins",
      },
      metadata: {
        managedBy: "dotagents",
      },
      name: "dotagents-local",
      owner: {
        name: "dotagents",
      },
      plugins: [
        {
          category: "Coding",
          description: "Tools for alpha-tools",
          name: "alpha-tools",
          source: {
            path: "./.agents/plugins/alpha-tools",
            source: "local",
          },
          version: "1.0.0",
        },
        {
          category: "Coding",
          description: "Tools for beta-tools",
          name: "beta-tools",
          source: {
            path: "./.agents/plugins/beta-tools",
            source: "local",
          },
          version: "1.0.0",
        },
      ],
    });
    expect(await readFile(join(root, ".claude-plugin", "marketplace.json"), "utf-8")).toBe(`{
  "metadata": {
    "managedBy": "dotagents"
  },
  "name": "dotagents",
  "owner": {
    "name": "dotagents"
  },
  "plugins": [
    {
      "description": "Tools for alpha-tools",
      "name": "alpha-tools",
      "source": "./.agents/plugins/alpha-tools",
      "version": "1.0.0"
    },
    {
      "description": "Tools for beta-tools",
      "name": "beta-tools",
      "source": "./.agents/plugins/beta-tools",
      "version": "1.0.0"
    }
  ]
}
`);
    expect(await readFile(join(root, ".cursor-plugin", "marketplace.json"), "utf-8")).toBe(await readFile(join(root, ".claude-plugin", "marketplace.json"), "utf-8"));

    const claudeManifest = JSON.parse(await readFile(join(root, ".agents", "plugins", "alpha-tools", ".claude-plugin", "plugin.json"), "utf-8")) as Record<string, unknown>;
    expect(claudeManifest["skills"]).toBe("./skills");
    expect(claudeManifest["commands"]).toBe("./commands");
    expect(claudeManifest["agents"]).toBeUndefined();
    expect(claudeManifest["category"]).toBeUndefined();
    expect(claudeManifest["metadata"]).toEqual({ managedBy: "dotagents" });

    const cursorManifest = JSON.parse(await readFile(join(root, ".agents", "plugins", "alpha-tools", ".cursor-plugin", "plugin.json"), "utf-8")) as Record<string, unknown>;
    expect(cursorManifest["skills"]).toBe("./skills");
    expect(cursorManifest["commands"]).toBe("./commands");
    expect(cursorManifest["agents"]).toBe("./agents");
    expect(cursorManifest["metadata"]).toEqual({ managedBy: "dotagents" });

    const codexManifest = JSON.parse(await readFile(join(root, ".agents", "plugins", "alpha-tools", ".codex-plugin", "plugin.json"), "utf-8")) as Record<string, unknown>;
    expect(codexManifest["skills"]).toBe("./skills");
    expect(codexManifest["commands"]).toBe("./commands");
    expect(codexManifest["agents"]).toBe("./agents");
    expect(codexManifest["interface"]).toEqual({
      capabilities: ["Interactive", "Write"],
      category: "Coding",
      developerName: "Sentry",
      displayName: "Alpha Tools",
      shortDescription: "Tools for alpha-tools",
    });

    expect(await verifyPluginOutputs(["cursor", "codex", "claude"], [beta, alpha], root)).toEqual([]);
  });

  it("projects explicit runtime component paths before conventional discovery", async () => {
    const alpha = await plugin("alpha-tools", {
      manifest: {
        agents: "custom-agents",
        commands: ["cmds/review.md"],
        hooks: "config/hooks.json",
        mcpServers: "config/mcp.json",
        rules: "cursor-rules",
        skills: "plugin-skills",
      },
    });

    const result = await writePluginOutputs(["claude", "cursor"], [alpha], root);

    expect(result.warnings).toEqual([]);
    expect(result.written).toBe(4);
    const claudeManifest = JSON.parse(await readFile(join(alpha.pluginDir, ".claude-plugin", "plugin.json"), "utf-8")) as Record<string, unknown>;
    expect(claudeManifest["agents"]).toBeUndefined();
    expect(claudeManifest["commands"]).toEqual(["./cmds/review.md"]);
    expect(claudeManifest["hooks"]).toBe("./config/hooks.json");
    expect(claudeManifest["mcpServers"]).toBe("./config/mcp.json");
    expect(claudeManifest["skills"]).toBe("./plugin-skills");

    const cursorManifest = JSON.parse(await readFile(join(alpha.pluginDir, ".cursor-plugin", "plugin.json"), "utf-8")) as Record<string, unknown>;
    expect(cursorManifest["agents"]).toBe("./custom-agents");
    expect(cursorManifest["commands"]).toEqual(["./cmds/review.md"]);
    expect(cursorManifest["hooks"]).toBe("./config/hooks.json");
    expect(cursorManifest["mcpServers"]).toBe("./config/mcp.json");
    expect(cursorManifest["rules"]).toBe("./cursor-rules");
    expect(cursorManifest["skills"]).toBe("./plugin-skills");
  });

  it("skips unsafe runtime component paths in generated manifests", async () => {
    const alpha = await plugin("alpha-tools", {
      manifest: {
        skills: "../outside",
      },
    });

    const result = await writePluginOutputs(["claude", "cursor", "codex"], [alpha], root);

    expect(result.written).toBe(6);
    expect(result.warnings).toEqual([
      {
        agent: "plugin",
        name: "alpha-tools",
        message: 'Plugin component path "../outside" for "skills" is not a safe relative path and was skipped.',
      },
      {
        agent: "plugin",
        name: "alpha-tools",
        message: 'Plugin component path "../outside" for "skills" is not a safe relative path and was skipped.',
      },
      {
        agent: "plugin",
        name: "alpha-tools",
        message: 'Plugin component path "../outside" for "skills" is not a safe relative path and was skipped.',
      },
    ]);
    const claudeManifest = JSON.parse(await readFile(join(alpha.pluginDir, ".claude-plugin", "plugin.json"), "utf-8")) as Record<string, unknown>;
    const cursorManifest = JSON.parse(await readFile(join(alpha.pluginDir, ".cursor-plugin", "plugin.json"), "utf-8")) as Record<string, unknown>;
    const codexManifest = JSON.parse(await readFile(join(alpha.pluginDir, ".codex-plugin", "plugin.json"), "utf-8")) as Record<string, unknown>;
    expect(claudeManifest["skills"]).toBeUndefined();
    expect(cursorManifest["skills"]).toBeUndefined();
    expect(codexManifest["skills"]).toBeUndefined();
  });

  it("does not overwrite unmanaged marketplace files", async () => {
    const alpha = await plugin("alpha-tools");
    await mkdir(join(root, ".claude-plugin"), { recursive: true });
    await writeFile(join(root, ".claude-plugin", "marketplace.json"), "{ \"name\": \"mine\" }\n", "utf-8");

    const result = await writePluginOutputs(["claude"], [alpha], root);

    expect(result.written).toBe(1);
    expect(result.warnings).toEqual([
      {
        agent: "claude",
        name: "marketplace",
        message: `Plugin marketplace exists and is not managed by dotagents: ${join(root, ".claude-plugin", "marketplace.json")}`,
      },
    ]);
    expect(await readFile(join(root, ".claude-plugin", "marketplace.json"), "utf-8")).toBe("{ \"name\": \"mine\" }\n");
    expect(existsSync(join(root, ".agents", "plugins", "alpha-tools", ".claude-plugin", "plugin.json"))).toBe(true);
  });

  it("does not overwrite unmanaged Codex marketplace files", async () => {
    const alpha = await plugin("alpha-tools");
    await writeFile(join(root, ".agents", "plugins", "marketplace.json"), "{ \"name\": \"mine\" }\n", "utf-8");

    const result = await writePluginOutputs(["codex"], [alpha], root);

    expect(result.warnings).toEqual([
      {
        agent: "codex",
        name: "marketplace",
        message: `Plugin marketplace exists and is not managed by dotagents: ${join(root, ".agents", "plugins", "marketplace.json")}`,
      },
    ]);
    expect(await readFile(join(root, ".agents", "plugins", "marketplace.json"), "utf-8")).toBe("{ \"name\": \"mine\" }\n");
    expect(existsSync(join(root, ".agents", "plugins", "alpha-tools", ".codex-plugin", "plugin.json"))).toBe(true);
  });

  it("does not overwrite unmanaged Codex plugin manifests", async () => {
    const alpha = await plugin("alpha-tools");
    await mkdir(join(alpha.pluginDir, ".codex-plugin"), { recursive: true });
    await writeFile(join(alpha.pluginDir, ".codex-plugin", "plugin.json"), "{ \"name\": \"mine\" }\n", "utf-8");

    const result = await writePluginOutputs(["codex"], [alpha], root);

    expect(result.warnings).toEqual([
      {
        agent: "codex",
        name: "alpha-tools",
        message: `Codex plugin manifest exists and is not managed by dotagents: ${join(root, ".agents", "plugins", "alpha-tools", ".codex-plugin", "plugin.json")}`,
      },
    ]);
    expect(await readFile(join(alpha.pluginDir, ".codex-plugin", "plugin.json"), "utf-8")).toBe("{ \"name\": \"mine\" }\n");
  });

  it("does not overwrite unmanaged Claude plugin manifests", async () => {
    const alpha = await plugin("alpha-tools");
    await mkdir(join(alpha.pluginDir, ".claude-plugin"), { recursive: true });
    await writeFile(join(alpha.pluginDir, ".claude-plugin", "plugin.json"), "{ \"name\": \"mine\" }\n", "utf-8");

    const result = await writePluginOutputs(["claude"], [alpha], root);

    expect(result.warnings).toEqual([
      {
        agent: "claude",
        name: "alpha-tools",
        message: `Claude plugin manifest exists and is not managed by dotagents: ${join(root, ".agents", "plugins", "alpha-tools", ".claude-plugin", "plugin.json")}`,
      },
    ]);
    expect(await readFile(join(alpha.pluginDir, ".claude-plugin", "plugin.json"), "utf-8")).toBe("{ \"name\": \"mine\" }\n");
  });

  it("does not overwrite unmanaged Cursor plugin manifests", async () => {
    const alpha = await plugin("alpha-tools");
    await mkdir(join(alpha.pluginDir, ".cursor-plugin"), { recursive: true });
    await writeFile(join(alpha.pluginDir, ".cursor-plugin", "plugin.json"), "{ \"name\": \"mine\" }\n", "utf-8");

    const result = await writePluginOutputs(["cursor"], [alpha], root);

    expect(result.warnings).toEqual([
      {
        agent: "cursor",
        name: "alpha-tools",
        message: `Cursor plugin manifest exists and is not managed by dotagents: ${join(root, ".agents", "plugins", "alpha-tools", ".cursor-plugin", "plugin.json")}`,
      },
    ]);
    expect(await readFile(join(alpha.pluginDir, ".cursor-plugin", "plugin.json"), "utf-8")).toBe("{ \"name\": \"mine\" }\n");
  });

  it("does not generate runtime outputs when no agent targets are selected", async () => {
    const alpha = await plugin("alpha-tools");

    const result = await writePluginOutputs([], [alpha], root);

    expect(result).toEqual({ warnings: [], written: 0 });
    expect(existsSync(join(root, ".agents", "plugins", "marketplace.json"))).toBe(false);
    expect(existsSync(join(root, ".claude-plugin", "marketplace.json"))).toBe(false);
    expect(existsSync(join(root, ".cursor-plugin", "marketplace.json"))).toBe(false);
  });

  it("warns and skips plugin targets that are not configured agents", async () => {
    const alpha = await plugin("alpha-tools", { targets: ["codex"] });

    const result = await writePluginOutputs(["claude"], [alpha], root);

    expect(result.written).toBe(0);
    expect(result.warnings).toEqual([
      {
        agent: "codex",
        name: "alpha-tools",
        message: 'Plugin "alpha-tools" targets "codex", but "codex" is not listed in agents.',
      },
    ]);
    expect(existsSync(join(root, ".agents", "plugins", "marketplace.json"))).toBe(false);
    expect(existsSync(join(root, ".agents", "plugins", "alpha-tools", ".codex-plugin", "plugin.json"))).toBe(false);
  });

  it("projects plugin skills and agents into OpenCode native locations", async () => {
    const alpha = await plugin("alpha-tools");
    await writePluginSkill(alpha.pluginDir, "plugin-qa");
    await writeFile(
      join(alpha.pluginDir, "agents", "plugin-reviewer.md"),
      "---\ndescription: Plugin reviewer\n---\nReview plugin output.\n",
      "utf-8",
    );

    const result = await writePluginOutputs(["opencode"], [alpha], root);

    expect(result.warnings).toEqual([]);
    expect(result.written).toBe(2);
    await expectSymlinkTarget(
      join(root, ".opencode", "skills", "plugin-qa"),
      join(alpha.pluginDir, "skills", "plugin-qa"),
    );
    await expectSymlinkTarget(
      join(root, ".opencode", "agents", "plugin-reviewer.md"),
      join(alpha.pluginDir, "agents", "plugin-reviewer.md"),
    );
    expect(await verifyPluginOutputs(["opencode"], [alpha], root)).toEqual([]);
  });

  it("projects explicit plugin component paths into OpenCode native locations", async () => {
    const alpha = await plugin("alpha-tools", {
      manifest: { skills: "components/skills", agents: "components/agents" },
    });
    await writePluginSkill(join(alpha.pluginDir, "components"), "plugin-qa");
    await mkdir(join(alpha.pluginDir, "components", "agents"), { recursive: true });
    await writeFile(
      join(alpha.pluginDir, "components", "agents", "plugin-reviewer.md"),
      "---\ndescription: Plugin reviewer\n---\nReview plugin output.\n",
      "utf-8",
    );

    const result = await writePluginOutputs(["opencode"], [alpha], root);

    expect(result.warnings).toEqual([]);
    expect(result.written).toBe(2);
    await expectSymlinkTarget(
      join(root, ".opencode", "skills", "plugin-qa"),
      join(alpha.pluginDir, "components", "skills", "plugin-qa"),
    );
    await expectSymlinkTarget(
      join(root, ".opencode", "agents", "plugin-reviewer.md"),
      join(alpha.pluginDir, "components", "agents", "plugin-reviewer.md"),
    );
  });

  it("projects plugin skills into Pi's native agentskills location", async () => {
    const alpha = await plugin("alpha-tools");
    await writePluginSkill(alpha.pluginDir, "plugin-qa");

    const result = await writePluginOutputs(["pi"], [alpha], root);

    expect(result.warnings).toEqual([]);
    expect(result.written).toBe(1);
    await expectSymlinkTarget(
      join(root, ".agents", "skills", "plugin-qa"),
      join(alpha.pluginDir, "skills", "plugin-qa"),
    );
  });

  it("warns and skips invalid Pi plugin skill names", async () => {
    const alpha = await plugin("alpha-tools");
    await mkdir(join(alpha.pluginDir, "skills", "bad"), { recursive: true });
    await writeFile(
      join(alpha.pluginDir, "skills", "bad", "SKILL.md"),
      `---\nname: ../../outside\ndescription: Bad skill\n---\n`,
      "utf-8",
    );

    const result = await writePluginOutputs(["pi"], [alpha], root);

    expect(result).toEqual({
      written: 0,
      warnings: [
        {
          agent: "pi",
          name: "alpha-tools",
          message: 'Plugin skill "../../outside" cannot be projected to Pi because skill names must start with alphanumeric and contain only [a-zA-Z0-9._-].',
        },
      ],
    });
    expect(existsSync(join(root, "outside"))).toBe(false);
    await expect(projectedPiSkillNames(["pi"], [alpha])).resolves.toEqual([]);
  });

  it("warns and skips unsafe plugin component paths for skill projections", async () => {
    const alpha = await plugin("alpha-tools", {
      manifest: {
        skills: "../outside",
      },
    });

    const result = await writePluginOutputs(["pi"], [alpha], root);

    expect(result).toEqual({
      written: 0,
      warnings: [
        {
          agent: "pi",
          name: "alpha-tools",
          message: 'Plugin component path "../outside" for "skills" is not a safe relative path and was skipped.',
        },
      ],
    });
    expect(existsSync(join(root, ".agents", "skills"))).toBe(false);
  });

  it("does not overwrite unmanaged Pi plugin skill projections", async () => {
    const alpha = await plugin("alpha-tools");
    await writePluginSkill(alpha.pluginDir, "plugin-qa");
    await mkdir(join(root, ".agents", "skills", "plugin-qa"), { recursive: true });
    await writeFile(join(root, ".agents", "skills", "plugin-qa", "SKILL.md"), "---\nname: plugin-qa\ndescription: Mine\n---\n", "utf-8");

    const result = await writePluginOutputs(["pi"], [alpha], root);

    expect(result).toEqual({
      written: 0,
      warnings: [
        {
          agent: "pi",
          name: "alpha-tools",
          message: `Pi plugin skill projection exists and is not managed by dotagents: ${join(root, ".agents", "skills", "plugin-qa")}`,
        },
      ],
    });
    expect((await lstat(join(root, ".agents", "skills", "plugin-qa"))).isDirectory()).toBe(true);
  });

  it("does not overwrite unmanaged OpenCode plugin component projections", async () => {
    const alpha = await plugin("alpha-tools");
    await writePluginSkill(alpha.pluginDir, "plugin-qa");
    await mkdir(join(root, ".opencode", "skills", "plugin-qa"), { recursive: true });
    await writeFile(join(root, ".opencode", "skills", "plugin-qa", "SKILL.md"), "---\nname: plugin-qa\ndescription: Mine\n---\n", "utf-8");

    const result = await writePluginOutputs(["opencode"], [alpha], root);

    expect(result).toEqual({
      written: 0,
      warnings: [
        {
          agent: "opencode",
          name: "alpha-tools",
          message: `OpenCode plugin skill projection exists and is not managed by dotagents: ${join(root, ".opencode", "skills", "plugin-qa")}`,
        },
      ],
    });
  });

  it("repairs dangling managed plugin component links", async () => {
    const alpha = await plugin("alpha-tools");
    await writePluginSkill(alpha.pluginDir, "plugin-qa");
    await mkdir(join(root, ".opencode", "skills"), { recursive: true });
    await symlink(
      relative(join(root, ".opencode", "skills"), join(root, ".agents", "plugins", "alpha-tools", "missing", "plugin-qa")),
      join(root, ".opencode", "skills", "plugin-qa"),
    );

    const result = await writePluginOutputs(["opencode"], [alpha], root);

    expect(result.warnings).toEqual([]);
    expect(result.written).toBe(1);
    await expectSymlinkTarget(
      join(root, ".opencode", "skills", "plugin-qa"),
      join(alpha.pluginDir, "skills", "plugin-qa"),
    );
  });

  it("warns and skips invalid OpenCode plugin skill names", async () => {
    const alpha = await plugin("alpha-tools");
    await writePluginSkill(alpha.pluginDir, "plugin_qa");

    const result = await writePluginOutputs(["opencode"], [alpha], root);

    expect(result).toEqual({
      written: 0,
      warnings: [
        {
          agent: "opencode",
          name: "alpha-tools",
          message: 'Plugin skill "plugin_qa" cannot be projected to OpenCode because OpenCode skill names must be lowercase alphanumeric with single hyphen separators.',
        },
      ],
    });
    expect(existsSync(join(root, ".opencode", "skills", "plugin_qa"))).toBe(false);
  });

  it("prunes stale managed runtime plugin outputs", async () => {
    const alpha = await plugin("alpha-tools");
    await writePluginSkill(alpha.pluginDir, "plugin-qa");
    await writeFile(
      join(alpha.pluginDir, "agents", "plugin-reviewer.md"),
      "---\ndescription: Plugin reviewer\n---\nReview plugin output.\n",
      "utf-8",
    );
    await mkdir(join(root, ".opencode", "plugins"), { recursive: true });
    await writeFile(
      join(root, ".opencode", "plugins", "alpha-tools.ts"),
      `// Generated by dotagents. Do not edit.\nexport { default } from "../.agents/plugins/alpha-tools/opencode/plugin.ts";\n`,
      "utf-8",
    );
    await writePluginOutputs(["claude", "cursor", "codex", "grok", "opencode", "pi"], [alpha], root);

    const pruned = await prunePluginOutputs([], [alpha], root);

    expect(pruned).toEqual([
      join(root, ".agents", "plugins", "marketplace.json"),
      join(root, ".claude-plugin", "marketplace.json"),
      join(root, ".cursor-plugin", "marketplace.json"),
      join(root, ".grok", "plugins", "alpha-tools"),
      join(root, ".opencode", "plugins", "alpha-tools.ts"),
      join(root, ".opencode", "skills", "plugin-qa"),
      join(root, ".opencode", "agents", "plugin-reviewer.md"),
      join(root, ".agents", "skills", "plugin-qa"),
      join(root, ".agents", "plugins", "alpha-tools", ".claude-plugin", "plugin.json"),
      join(root, ".agents", "plugins", "alpha-tools", ".cursor-plugin", "plugin.json"),
      join(root, ".agents", "plugins", "alpha-tools", ".codex-plugin", "plugin.json"),
    ]);
    expect(existsSync(join(root, ".agents", "plugins", "marketplace.json"))).toBe(false);
    expect(existsSync(join(root, ".claude-plugin", "marketplace.json"))).toBe(false);
    expect(existsSync(join(root, ".cursor-plugin", "marketplace.json"))).toBe(false);
    expect(existsSync(join(root, ".grok", "plugins", "alpha-tools"))).toBe(false);
    expect(existsSync(join(root, ".opencode", "plugins", "alpha-tools.ts"))).toBe(false);
    expect(existsSync(join(root, ".opencode", "skills", "plugin-qa"))).toBe(false);
    expect(existsSync(join(root, ".opencode", "agents", "plugin-reviewer.md"))).toBe(false);
    expect(existsSync(join(root, ".agents", "skills", "plugin-qa"))).toBe(false);
    expect(existsSync(join(root, ".agents", "plugins", "alpha-tools", ".claude-plugin", "plugin.json"))).toBe(false);
    expect(existsSync(join(root, ".agents", "plugins", "alpha-tools", ".cursor-plugin", "plugin.json"))).toBe(false);
    expect(existsSync(join(root, ".agents", "plugins", "alpha-tools", ".codex-plugin", "plugin.json"))).toBe(false);
  });

  it("does not rewrite unchanged managed Grok projections", async () => {
    const alpha = await plugin("alpha-tools");

    const first = await writePluginOutputs(["grok"], [alpha], root);
    const second = await writePluginOutputs(["grok"], [alpha], root);

    expect(first.written).toBe(1);
    expect(second.written).toBe(0);
  });

  it("compares managed Grok projection files as bytes", async () => {
    const alpha = await plugin("alpha-tools");
    await mkdir(join(alpha.pluginDir, "bin"), { recursive: true });
    await writeFile(join(alpha.pluginDir, "bin", "blob"), Buffer.from([0xff]));

    const first = await writePluginOutputs(["grok"], [alpha], root);
    await writeFile(join(alpha.pluginDir, "bin", "blob"), Buffer.from([0xef, 0xbf, 0xbd]));
    const second = await writePluginOutputs(["grok"], [alpha], root);

    expect(first.written).toBe(1);
    expect(second.written).toBe(1);
    expect(await readFile(join(root, ".grok", "plugins", "alpha-tools", "bin", "blob"))).toEqual(Buffer.from([0xef, 0xbf, 0xbd]));
  });
});
