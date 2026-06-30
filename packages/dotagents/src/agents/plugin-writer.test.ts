import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PluginDeclaration } from "./plugin-store.js";
import {
  prunePluginOutputs,
  verifyPluginOutputs,
  writePluginOutputs,
} from "./plugin-writer.js";

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

  it("writes deterministic marketplace outputs for supported runtimes", async () => {
    const alpha = await plugin("alpha-tools");
    const beta = await plugin("beta-tools");

    const result = await writePluginOutputs(
      ["cursor", "codex", "claude"],
      [beta, alpha],
      root,
    );

    expect(result.warnings).toEqual([]);
    expect(result.written).toBe(5);
    expect(await readFile(join(root, ".agents", "plugins", "marketplace.json"), "utf-8")).toBe(`{
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
      "description": "Tools for alpha-tools",
      "name": "alpha-tools",
      "policy": {
        "authentication": "ON_INSTALL",
        "installation": "AVAILABLE"
      },
      "source": {
        "path": ".agents/plugins/alpha-tools",
        "source": "local"
      },
      "version": "1.0.0"
    },
    {
      "category": "Coding",
      "description": "Tools for beta-tools",
      "name": "beta-tools",
      "policy": {
        "authentication": "ON_INSTALL",
        "installation": "AVAILABLE"
      },
      "source": {
        "path": ".agents/plugins/beta-tools",
        "source": "local"
      },
      "version": "1.0.0"
    }
  ]
}
`);
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
      "source": ".agents/plugins/alpha-tools",
      "version": "1.0.0"
    },
    {
      "description": "Tools for beta-tools",
      "name": "beta-tools",
      "source": ".agents/plugins/beta-tools",
      "version": "1.0.0"
    }
  ]
}
`);
    expect(await readFile(join(root, ".cursor-plugin", "marketplace.json"), "utf-8")).toBe(await readFile(join(root, ".claude-plugin", "marketplace.json"), "utf-8"));

    const codexManifest = JSON.parse(await readFile(join(root, ".agents", "plugins", "alpha-tools", ".codex-plugin", "plugin.json"), "utf-8")) as Record<string, unknown>;
    expect(codexManifest["skills"]).toBe("./skills");
    expect(codexManifest["commands"]).toBe("./commands");
    expect(codexManifest["interface"]).toEqual({
      capabilities: ["Interactive", "Write"],
      category: "Coding",
      developerName: "Sentry",
      displayName: "Alpha Tools",
      shortDescription: "Tools for alpha-tools",
    });

    expect(await verifyPluginOutputs(["cursor", "codex", "claude"], [beta, alpha], root)).toEqual([]);
  });

  it("does not overwrite unmanaged marketplace files", async () => {
    const alpha = await plugin("alpha-tools");
    await mkdir(join(root, ".claude-plugin"), { recursive: true });
    await writeFile(join(root, ".claude-plugin", "marketplace.json"), "{ \"name\": \"mine\" }\n", "utf-8");

    const result = await writePluginOutputs(["claude"], [alpha], root);

    expect(result.written).toBe(0);
    expect(result.warnings).toEqual([
      {
        agent: "claude",
        name: "marketplace",
        message: `Plugin marketplace exists and is not managed by dotagents: ${join(root, ".claude-plugin", "marketplace.json")}`,
      },
    ]);
    expect(await readFile(join(root, ".claude-plugin", "marketplace.json"), "utf-8")).toBe("{ \"name\": \"mine\" }\n");
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

  it("prunes stale managed runtime plugin outputs", async () => {
    const alpha = await plugin("alpha-tools", {
      manifest: { opencode: { plugins: ["opencode/plugin.ts"] } },
    });
    await mkdir(join(alpha.pluginDir, "opencode"), { recursive: true });
    await writeFile(join(alpha.pluginDir, "opencode", "plugin.ts"), "export default {}\n", "utf-8");
    await writePluginOutputs(["codex", "grok", "opencode"], [alpha], root);

    const pruned = await prunePluginOutputs([], [alpha], root);

    expect(pruned).toEqual([
      join(root, ".agents", "plugins", "marketplace.json"),
      join(root, ".grok", "plugins", "alpha-tools"),
      join(root, ".opencode", "plugins", "alpha-tools.ts"),
      join(root, ".agents", "plugins", "alpha-tools", ".codex-plugin", "plugin.json"),
    ]);
    expect(existsSync(join(root, ".agents", "plugins", "marketplace.json"))).toBe(false);
    expect(existsSync(join(root, ".grok", "plugins", "alpha-tools"))).toBe(false);
    expect(existsSync(join(root, ".opencode", "plugins", "alpha-tools.ts"))).toBe(false);
    expect(existsSync(join(root, ".agents", "plugins", "alpha-tools", ".codex-plugin", "plugin.json"))).toBe(false);
  });

  it("does not rewrite unchanged managed Grok projections", async () => {
    const alpha = await plugin("alpha-tools");

    const first = await writePluginOutputs(["grok"], [alpha], root);
    const second = await writePluginOutputs(["grok"], [alpha], root);

    expect(first.written).toBe(1);
    expect(second.written).toBe(0);
  });
});
