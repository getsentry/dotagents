import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installPluginBundle, isSameProjectPluginConfig, lockEntryForPlugin, resolvePlugin, type ResolvedPlugin } from "./store.js";
import { AGENT_PLUGIN_SCHEMA, AGENT_PLUGIN_MCP_SCHEMA } from "./schema.js";

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    realpath: vi.fn(actual.realpath),
    rename: vi.fn(actual.rename),
  };
});

describe("plugin store", () => {
  afterEach(async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(realpath).mockImplementation(actual.realpath);
    vi.mocked(rename).mockImplementation(actual.rename);
  });

  it("preserves an empty resolved path for root git plugins", () => {
    const resolved = {
      type: "git",
      resolvedUrl: "https://github.com/org/review-tools.git",
      resolvedPath: "",
      commit: "abc123",
      plugin: {
        name: "review-tools",
        source: "org/review-tools",
        pluginDir: "/tmp/review-tools",
        manifest: { name: "review-tools" },
      },
    } satisfies ResolvedPlugin;

    expect(lockEntryForPlugin(resolved)).toEqual({
      source: "org/review-tools",
      resolved_url: "https://github.com/org/review-tools.git",
      resolved_path: "",
      resolved_commit: "abc123",
    });
  });

  it("preserves a standard Agent Plugin bundle during install", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "dotagents-plugin-store-"));
    const sourceDir = join(projectRoot, "source", "review-tools");
    const pluginsDir = join(projectRoot, ".agents", "plugins");
    await mkdir(join(sourceDir, "skills", "review"), { recursive: true });
    await mkdir(pluginsDir, { recursive: true });
    const manifest = {
      $schema: AGENT_PLUGIN_SCHEMA,
      name: "review-tools",
      description: "Review tools",
      extensions: { "com.example.client": { enabled: true } },
    };
    await writeFile(join(sourceDir, "plugin.json"), JSON.stringify(manifest, null, 2));
    await writeFile(join(sourceDir, "mcp.json"), JSON.stringify({
      $schema: AGENT_PLUGIN_MCP_SCHEMA,
      mcpServers: {},
    }, null, 2));
    await writeFile(join(sourceDir, "skills", "review", "SKILL.md"), "---\nname: review\ndescription: Review\n---\n");

    try {
      const installed = await installPluginBundle(pluginsDir, {
        type: "local",
        plugin: {
          name: "review-tools",
          source: "path:source/review-tools",
          pluginDir: sourceDir,
          manifest,
        },
      });
      expect(installed.manifest.$schema).toBe(AGENT_PLUGIN_SCHEMA);
      expect(JSON.parse(await readFile(join(installed.pluginDir, "plugin.json"), "utf-8"))).toEqual(manifest);
      expect(existsSync(join(installed.pluginDir, "mcp.json"))).toBe(true);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("rejects plugin bundle symlinks that escape the installed plugin", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "dotagents-plugin-store-"));
    const sourceDir = join(projectRoot, "source", "review-tools");
    const pluginsDir = join(projectRoot, ".agents", "plugins");
    const outsideFile = join(projectRoot, "secret.txt");
    await mkdir(join(sourceDir, "agents"), { recursive: true });
    await mkdir(pluginsDir, { recursive: true });
    await writeFile(join(sourceDir, "plugin.json"), JSON.stringify({ name: "review-tools" }));
    await writeFile(outsideFile, "secret");
    await symlink(outsideFile, join(sourceDir, "agents", "evil.md"));

    try {
      await expect(installPluginBundle(pluginsDir, {
        type: "local",
        plugin: {
          name: "review-tools",
          source: "path:source/review-tools",
          pluginDir: sourceDir,
          manifest: { name: "review-tools" },
        },
      })).rejects.toThrow("Plugin bundle symlink resolves outside the plugin directory");
      expect(existsSync(join(pluginsDir, "review-tools"))).toBe(false);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("does not treat missing canonical plugin dirs as same-project plugins", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "dotagents-plugin-store-"));
    const pluginsDir = join(projectRoot, ".agents", "plugins");
    await mkdir(pluginsDir, { recursive: true });

    expect(isSameProjectPluginConfig(
      { name: "review-tools", source: "path:." },
      pluginsDir,
      projectRoot,
    )).toBe(false);
  });

  it("keeps the backup when replacing an installed plugin fails and rollback also fails", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "dotagents-plugin-store-"));
    try {
      const sourceDir = join(projectRoot, "source", "review-tools");
      const pluginsDir = join(projectRoot, ".agents", "plugins");
      const destDir = join(pluginsDir, "review-tools");
      await mkdir(sourceDir, { recursive: true });
      await mkdir(destDir, { recursive: true });
      await writeFile(
        join(sourceDir, "plugin.json"),
        JSON.stringify({ name: "review-tools", description: "New plugin" }),
        "utf-8",
      );
      await writeFile(
        join(destDir, "plugin.json"),
        JSON.stringify({ name: "review-tools", description: "Original plugin" }),
        "utf-8",
      );

      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      vi.mocked(rename).mockImplementation(async (oldPath, newPath) => {
        const oldString = String(oldPath);
        const newString = String(newPath);
        if (oldString.includes(".tmp-") && newString === destDir) {
          throw new Error("destination rename failed");
        }
        if (oldString.includes(".backup-") && newString === destDir) {
          throw new Error("rollback failed");
        }
        await actual.rename(oldPath, newPath);
      });

      await expect(installPluginBundle(pluginsDir, {
        type: "local",
        plugin: {
          name: "review-tools",
          source: "path:source/review-tools",
          pluginDir: sourceDir,
          manifest: { name: "review-tools", description: "New plugin" },
        },
      })).rejects.toThrow("destination rename failed");

      expect(existsSync(destDir)).toBe(false);
      const backupName = (await readdir(pluginsDir)).find((name) => name.startsWith(".review-tools.backup-"));
      expect(backupName).toBeDefined();
      const backupManifest = JSON.parse(await readFile(join(pluginsDir, backupName!, "plugin.json"), "utf-8"));
      expect(backupManifest.description).toBe("Original plugin");
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("detects same-project plugins without requiring the explicit source path to exist", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "dotagents-plugin-store-"));
    const pluginsDir = join(projectRoot, ".agents", "plugins");
    await mkdir(pluginsDir, { recursive: true });

    expect(isSameProjectPluginConfig(
      { name: "review-tools", source: "path:.agents/plugins/review-tools" },
      pluginsDir,
      projectRoot,
    )).toBe(true);
    expect(isSameProjectPluginConfig(
      { name: "review-tools", source: "path:.", path: ".agents/plugins/review-tools" },
      pluginsDir,
      projectRoot,
    )).toBe(true);
  });

  it("rejects canonical plugin discovery symlinks that escape the source root", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "dotagents-plugin-store-"));
    try {
      const sourceRoot = join(projectRoot, "source");
      const outsideDir = join(projectRoot, "outside", "review-tools");
      await mkdir(join(sourceRoot, ".agents", "plugins"), { recursive: true });
      await mkdir(outsideDir, { recursive: true });
      await writeFile(
        join(outsideDir, "plugin.json"),
        JSON.stringify({ name: "review-tools" }),
        "utf-8",
      );
      await symlink(outsideDir, join(sourceRoot, ".agents", "plugins", "review-tools"));

      await expect(resolvePlugin(
        { name: "review-tools", source: "path:source" },
        { stateDir: join(projectRoot, "state"), projectRoot },
      )).rejects.toThrow(/Canonical plugin source resolves outside source/);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("reports a controlled error when the plugin source root disappears during realpath checks", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "dotagents-plugin-store-"));
    try {
      const sourceRoot = join(projectRoot, "source");
      const pluginDir = join(sourceRoot, "plugins", "review-tools");
      await mkdir(pluginDir, { recursive: true });
      await writeFile(
        join(pluginDir, "plugin.json"),
        JSON.stringify({ name: "review-tools" }),
        "utf-8",
      );

      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      const missingRoot = new Error("missing source root") as NodeJS.ErrnoException;
      missingRoot.code = "ENOENT";
      vi.mocked(realpath).mockImplementation(async (path, options) => {
        if (String(path) === sourceRoot) {
          throw missingRoot;
        }
        return actual.realpath(path, options);
      });

      let error: unknown;
      try {
        await resolvePlugin(
          { name: "review-tools", source: "path:source", path: "plugins/review-tools" },
          { stateDir: join(projectRoot, "state"), projectRoot },
        );
      } catch (err) {
        error = err;
      }

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("Plugin path source root does not exist: plugins/review-tools");
      expect((error as Error).cause).toBe(missingRoot);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("rejects explicit plugin path symlinks that escape the source root", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "dotagents-plugin-store-"));
    try {
      const sourceRoot = join(projectRoot, "source");
      const outsideDir = join(projectRoot, "outside", "review-tools");
      await mkdir(join(sourceRoot, "plugins"), { recursive: true });
      await mkdir(outsideDir, { recursive: true });
      await writeFile(
        join(outsideDir, "plugin.json"),
        JSON.stringify({ name: "review-tools" }),
        "utf-8",
      );
      await symlink(outsideDir, join(sourceRoot, "plugins", "review-tools"));

      await expect(resolvePlugin(
        { name: "review-tools", source: "path:source", path: "plugins/review-tools" },
        { stateDir: join(projectRoot, "state"), projectRoot },
      )).rejects.toThrow(/Plugin path resolves outside source/);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("rejects marketplace plugin source symlinks that escape the source root", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "dotagents-plugin-store-"));
    try {
      const sourceRoot = join(projectRoot, "source");
      const outsideDir = join(projectRoot, "outside", "review-tools");
      await mkdir(join(sourceRoot, "plugins"), { recursive: true });
      await mkdir(outsideDir, { recursive: true });
      await writeFile(
        join(outsideDir, "plugin.json"),
        JSON.stringify({ name: "review-tools" }),
        "utf-8",
      );
      await symlink(outsideDir, join(sourceRoot, "plugins", "review-tools"));
      await writeFile(
        join(sourceRoot, "marketplace.json"),
        JSON.stringify({
          name: "test-marketplace",
          plugins: [
            {
              name: "review-tools",
              source: { source: "local", path: "plugins/review-tools" },
            },
          ],
        }),
        "utf-8",
      );

      await expect(resolvePlugin(
        { name: "review-tools", source: "path:source" },
        { stateDir: join(projectRoot, "state"), projectRoot },
      )).rejects.toThrow(/Marketplace plugin source resolves outside source/);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("resolves marketplace paths relative to nested marketplace files", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "dotagents-plugin-store-"));
    try {
      const sourceRoot = join(projectRoot, "source");
      const pluginDir = join(sourceRoot, ".agents", "plugins", "marketplace-review-tools");
      await mkdir(join(sourceRoot, ".claude-plugin"), { recursive: true });
      await mkdir(pluginDir, { recursive: true });
      await writeFile(
        join(pluginDir, "plugin.json"),
        JSON.stringify({ name: "review-tools", description: "Nested marketplace plugin" }),
        "utf-8",
      );
      await writeFile(
        join(sourceRoot, ".claude-plugin", "marketplace.json"),
        JSON.stringify({
          name: "test-marketplace",
          plugins: [
            {
              name: "review-tools",
              source: "../.agents/plugins/marketplace-review-tools",
            },
          ],
        }),
        "utf-8",
      );

      const fromMarketplace = await resolvePlugin(
        { name: "review-tools", source: "path:source" },
        { stateDir: join(projectRoot, "state"), projectRoot },
      );
      expect(fromMarketplace.plugin.pluginDir).toBe(pluginDir);
      expect(fromMarketplace.plugin.manifest.description).toBe("Nested marketplace plugin");
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("skips unsupported marketplace entries without dropping local entries", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "dotagents-plugin-store-"));
    try {
      const sourceRoot = join(projectRoot, "source");
      const pluginDir = join(sourceRoot, "marketplace", "review-tools");
      await mkdir(pluginDir, { recursive: true });
      await writeFile(
        join(pluginDir, "plugin.json"),
        JSON.stringify({ name: "review-tools", description: "Local marketplace plugin" }),
        "utf-8",
      );
      await writeFile(
        join(sourceRoot, "marketplace.json"),
        JSON.stringify({
          name: "test-marketplace",
          plugins: [
            {
              name: "review-tools",
              source: {
                source: "github",
                repo: "org/review-tools",
              },
            },
            {
              name: "review-tools",
              source: { source: "local", path: "marketplace/review-tools" },
            },
          ],
        }),
        "utf-8",
      );

      const fromMarketplace = await resolvePlugin(
        { name: "review-tools", source: "path:source" },
        { stateDir: join(projectRoot, "state"), projectRoot },
      );
      expect(fromMarketplace.plugin.pluginDir).toBe(pluginDir);
      expect(fromMarketplace.plugin.manifest.description).toBe("Local marketplace plugin");
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("rejects marketplace paths that traverse outside the source root", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "dotagents-plugin-store-"));
    try {
      const sourceRoot = join(projectRoot, "source");
      const outsideDir = join(projectRoot, "outside", "review-tools");
      await mkdir(join(sourceRoot, ".claude-plugin"), { recursive: true });
      await mkdir(outsideDir, { recursive: true });
      await writeFile(
        join(outsideDir, "plugin.json"),
        JSON.stringify({ name: "review-tools" }),
        "utf-8",
      );
      await writeFile(
        join(sourceRoot, ".claude-plugin", "marketplace.json"),
        JSON.stringify({
          name: "test-marketplace",
          plugins: [
            {
              name: "review-tools",
              source: "../../outside/review-tools",
            },
          ],
        }),
        "utf-8",
      );

      await expect(resolvePlugin(
        { name: "review-tools", source: "path:source" },
        { stateDir: join(projectRoot, "state"), projectRoot },
      )).rejects.toThrow(/Marketplace plugin source resolves outside source/);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("rejects conventional plugin discovery symlinks that escape the source root", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "dotagents-plugin-store-"));
    try {
      const sourceRoot = join(projectRoot, "source");
      const outsideDir = join(projectRoot, "outside", "review-tools");
      await mkdir(join(sourceRoot, "plugins"), { recursive: true });
      await mkdir(outsideDir, { recursive: true });
      await writeFile(
        join(outsideDir, "plugin.json"),
        JSON.stringify({ name: "review-tools" }),
        "utf-8",
      );
      await symlink(outsideDir, join(sourceRoot, "plugins", "review-tools"));

      await expect(resolvePlugin(
        { name: "review-tools", source: "path:source" },
        { stateDir: join(projectRoot, "state"), projectRoot },
      )).rejects.toThrow(/Plugin source resolves outside source/);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});
