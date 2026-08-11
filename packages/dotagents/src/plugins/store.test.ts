import { existsSync } from "node:fs";
import { lstat, mkdtemp, mkdir, readdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  discoverPlugins,
  installPluginBundle,
  isSameProjectPluginConfig,
  loadInstalledPlugins,
  lockEntryForPlugin,
  resolvePlugin,
  type ResolvedPlugin,
} from "./store.js";

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    realpath: vi.fn(actual.realpath),
    rename: vi.fn(actual.rename),
    rm: vi.fn(actual.rm),
  };
});

describe("plugin store", () => {
  afterEach(async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(realpath).mockImplementation(actual.realpath);
    vi.mocked(rename).mockImplementation(actual.rename);
    vi.mocked(rm).mockImplementation(actual.rm);
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

  it("rejects broken plugin bundle symlinks", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "dotagents-plugin-store-"));
    const sourceDir = join(projectRoot, "source", "review-tools");
    const pluginsDir = join(projectRoot, ".agents", "plugins");
    await mkdir(sourceDir, { recursive: true });
    await mkdir(pluginsDir, { recursive: true });
    await writeFile(join(sourceDir, "plugin.json"), JSON.stringify({ name: "review-tools" }));
    await symlink("missing.md", join(sourceDir, "broken.md"));

    try {
      await expect(installPluginBundle(pluginsDir, {
        type: "local",
        plugin: {
          name: "review-tools",
          source: "path:source/review-tools",
          pluginDir: sourceDir,
          manifest: { name: "review-tools" },
        },
      })).rejects.toThrow("Plugin bundle contains an invalid symlink");
      expect(existsSync(join(pluginsDir, "review-tools"))).toBe(false);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("rejects installed plugin roots that resolve outside the plugin directory", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "dotagents-plugin-store-"));
    const pluginsDir = join(projectRoot, ".agents", "plugins");
    const outsideDir = join(projectRoot, "outside", "review-tools");
    await mkdir(pluginsDir, { recursive: true });
    await mkdir(outsideDir, { recursive: true });
    await writeFile(join(outsideDir, "plugin.json"), JSON.stringify({ name: "review-tools" }));
    await symlink(outsideDir, join(pluginsDir, "review-tools"));

    try {
      const result = await loadInstalledPlugins(pluginsDir, [{
        name: "review-tools",
        source: "path:source/review-tools",
      }], "npx @sentry/dotagents install");
      expect(result.plugins).toEqual([]);
      expect(result.issues[0]?.issue).toContain("Installed plugin resolves outside source");
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("reports installed plugin bundles without a manifest", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "dotagents-plugin-store-"));
    const pluginsDir = join(projectRoot, ".agents", "plugins");
    await mkdir(join(pluginsDir, "review-tools", "skills"), { recursive: true });

    try {
      const result = await loadInstalledPlugins(pluginsDir, [{
        name: "review-tools",
        source: "path:source/review-tools",
      }], "npx @sentry/dotagents install");
      expect(result.plugins).toEqual([]);
      expect(result.issues[0]?.issue).toContain("has no plugin.json or supported native manifest");
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

  it("commits an install when obsolete backup cleanup fails", async () => {
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
      vi.mocked(rm).mockImplementation(async (path, options) => {
        if (String(path).includes(".backup-")) {throw new Error("backup cleanup failed");}
        await actual.rm(path, options);
      });

      await expect(installPluginBundle(pluginsDir, {
        type: "local",
        plugin: {
          name: "review-tools",
          source: "path:source/review-tools",
          pluginDir: sourceDir,
          manifest: { name: "review-tools", description: "New plugin" },
        },
      })).resolves.toMatchObject({ pluginDir: destDir });

      const installedManifest = JSON.parse(await readFile(join(destDir, "plugin.json"), "utf-8"));
      expect(installedManifest.description).toBe("New plugin");
      expect((await readdir(pluginsDir)).some((name) => name.includes(".backup-"))).toBe(true);
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

  it("installs contained plugin directory symlinks from their canonical root", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "dotagents-plugin-store-"));
    try {
      const sourceRoot = join(projectRoot, "source");
      const actualDir = join(sourceRoot, "actual", "review-tools");
      const aliasDir = join(sourceRoot, "plugins", "review-tools");
      const pluginsDir = join(projectRoot, ".agents", "plugins");
      await mkdir(join(actualDir, "skills", "review"), { recursive: true });
      await mkdir(dirname(aliasDir), { recursive: true });
      await mkdir(pluginsDir, { recursive: true });
      await writeFile(join(actualDir, "plugin.json"), JSON.stringify({ name: "review-tools" }));
      await writeFile(join(actualDir, "skills", "review", "SKILL.md"), "---\nname: review\ndescription: Review\n---\n");
      await symlink(relative(dirname(aliasDir), actualDir), aliasDir);

      const resolved = await resolvePlugin(
        { name: "review-tools", source: "path:source", path: "plugins/review-tools" },
        { stateDir: join(projectRoot, "state"), projectRoot },
      );
      const installed = await installPluginBundle(pluginsDir, resolved);

      expect((await lstat(installed.pluginDir)).isDirectory()).toBe(true);
      expect(existsSync(join(installed.pluginDir, "plugin.json"))).toBe(true);
      expect(existsSync(join(installed.pluginDir, "skills", "review", "SKILL.md"))).toBe(true);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("rejects legacy root components in standard bundles", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "dotagents-plugin-store-"));
    try {
      const pluginDir = join(projectRoot, "source", "plugins", "review-tools");
      await mkdir(join(pluginDir, "agents"), { recursive: true });
      await writeFile(join(pluginDir, "plugin.json"), JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
        name: "review-tools",
      }));

      await expect(resolvePlugin(
        { name: "review-tools", source: "path:source", path: "plugins/review-tools" },
        { stateDir: join(projectRoot, "state"), projectRoot },
      )).rejects.toThrow(/contains legacy root components: agents/);
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

  it("reports a controlled error when a plugin path disappears during realpath checks", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "dotagents-plugin-store-"));
    try {
      const sourceRoot = join(projectRoot, "source");
      const pluginDir = join(sourceRoot, "plugins", "review-tools");
      await mkdir(pluginDir, { recursive: true });
      await writeFile(join(pluginDir, "plugin.json"), JSON.stringify({ name: "review-tools" }), "utf-8");

      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      const missingPath = new Error("missing plugin path") as NodeJS.ErrnoException;
      missingPath.code = "ENOENT";
      vi.mocked(realpath).mockImplementation(async (path, options) => {
        if (String(path) === pluginDir) {throw missingPath;}
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
      expect((error as Error).message).toBe("Plugin path source path does not exist: plugins/review-tools");
      expect((error as Error).cause).toBe(missingPath);
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

  it("prefers repository-root paths in nested Claude marketplaces", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "dotagents-plugin-store-"));
    try {
      const sourceRoot = join(projectRoot, "source");
      const pluginDir = join(sourceRoot, "plugins", "frontend-design");
      await mkdir(join(sourceRoot, ".claude-plugin"), { recursive: true });
      await mkdir(join(pluginDir, ".claude-plugin"), { recursive: true });
      await writeFile(
        join(pluginDir, ".claude-plugin", "plugin.json"),
        JSON.stringify({ name: "frontend-design" }),
      );
      await writeFile(
        join(sourceRoot, ".claude-plugin", "marketplace.json"),
        JSON.stringify({
          name: "official",
          plugins: [{ name: "frontend-design", source: "./plugins/frontend-design" }],
        }),
      );

      const fromMarketplace = await resolvePlugin(
        { name: "frontend-design", source: "path:source" },
        { stateDir: join(projectRoot, "state"), projectRoot },
      );
      expect(fromMarketplace.plugin.pluginDir).toBe(pluginDir);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("ignores unrelated marketplace failures during named discovery", async () => {
    const sourceRoot = await mkdtemp(join(tmpdir(), "dotagents-plugin-store-"));
    try {
      const pluginDir = join(sourceRoot, "plugins", "frontend-design");
      await mkdir(join(sourceRoot, ".claude-plugin"), { recursive: true });
      await mkdir(join(pluginDir, ".claude-plugin"), { recursive: true });
      await writeFile(
        join(pluginDir, ".claude-plugin", "plugin.json"),
        JSON.stringify({ name: "frontend-design" }),
      );
      await writeFile(
        join(sourceRoot, ".claude-plugin", "marketplace.json"),
        JSON.stringify({
          name: "official",
          plugins: [
            { name: "broken", source: "./plugins/broken" },
            { name: "frontend-design", source: "./plugins/frontend-design" },
          ],
        }),
      );

      await expect(discoverPlugins(sourceRoot)).rejects.toThrow('Marketplace plugin "broken"');
      await expect(discoverPlugins(sourceRoot, ["frontend-design"])).resolves.toMatchObject([
        { name: "frontend-design", path: "plugins/frontend-design" },
      ]);
    } finally {
      await rm(sourceRoot, { recursive: true, force: true });
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

  it("keeps named resolution tolerant of an unrelated malformed root plugin", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "dotagents-plugin-store-"));
    try {
      const sourceRoot = join(projectRoot, "source");
      const pluginDir = join(sourceRoot, "plugins", "review-tools");
      await mkdir(pluginDir, { recursive: true });
      await writeFile(join(sourceRoot, "plugin.json"), "{", "utf-8");
      await writeFile(
        join(pluginDir, "plugin.json"),
        JSON.stringify({ name: "review-tools" }),
        "utf-8",
      );

      await expect(discoverPlugins(sourceRoot)).rejects.toThrow(join(sourceRoot, "plugin.json"));
      await expect(resolvePlugin(
        { name: "review-tools", source: "path:source" },
        { stateDir: join(projectRoot, "state"), projectRoot },
      )).resolves.toMatchObject({ plugin: { pluginDir } });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("keeps named resolution tolerant of an unrelated malformed conventional candidate", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "dotagents-plugin-store-"));
    try {
      const sourceRoot = join(projectRoot, "source");
      const containerDir = join(sourceRoot, "plugins", "collection");
      const pluginDir = join(containerDir, "review-tools");
      await mkdir(pluginDir, { recursive: true });
      await writeFile(join(containerDir, "plugin.json"), "{", "utf-8");
      await writeFile(
        join(pluginDir, "plugin.json"),
        JSON.stringify({ name: "review-tools" }),
        "utf-8",
      );

      await expect(discoverPlugins(sourceRoot)).rejects.toThrow(join(containerDir, "plugin.json"));
      await expect(resolvePlugin(
        { name: "review-tools", source: "path:source" },
        { stateDir: join(projectRoot, "state"), projectRoot },
      )).resolves.toMatchObject({ plugin: { pluginDir } });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("ignores a conventional plugins path that is not a directory", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "dotagents-plugin-store-"));
    try {
      await writeFile(join(projectRoot, "plugins"), "not a directory", "utf-8");

      await expect(resolvePlugin(
        { name: "review-tools", source: "path:." },
        { stateDir: join(projectRoot, "state"), projectRoot },
      )).rejects.toThrow('Plugin "review-tools" not found');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("discovers root, conventional, native, and local marketplace plugins with safe paths", async () => {
    const sourceRoot = await mkdtemp(join(tmpdir(), "dotagents-plugin-catalog-"));
    try {
      const canonicalDir = join(sourceRoot, ".agents", "plugins", "canonical");
      const conventionalDir = join(sourceRoot, "plugins", "conventional");
      const marketplaceDir = join(sourceRoot, "catalog", "marketplace");
      await mkdir(join(sourceRoot, ".codex-plugin"), { recursive: true });
      await mkdir(canonicalDir, { recursive: true });
      await mkdir(conventionalDir, { recursive: true });
      await mkdir(marketplaceDir, { recursive: true });
      await writeFile(
        join(sourceRoot, ".codex-plugin", "plugin.json"),
        JSON.stringify({ name: "root-plugin" }),
      );
      await writeFile(join(canonicalDir, "plugin.json"), JSON.stringify({ name: "canonical" }));
      await writeFile(join(conventionalDir, "plugin.json"), JSON.stringify({ name: "conventional" }));
      await writeFile(join(marketplaceDir, "plugin.json"), JSON.stringify({ name: "marketplace" }));
      await writeFile(
        join(sourceRoot, "marketplace.json"),
        JSON.stringify({
          name: "test",
          plugins: [
            { name: "marketplace", source: "./catalog/marketplace" },
            { name: "conventional", source: "./plugins/conventional" },
          ],
        }),
      );

      const candidates = await discoverPlugins(sourceRoot);

      expect(candidates.map((candidate) => ({
        name: candidate.manifest.name,
        path: candidate.path,
        nativeSource: candidate.nativeSource,
      }))).toEqual(expect.arrayContaining([
        { name: "root-plugin", path: "", nativeSource: "codex" },
        { name: "canonical", path: ".agents/plugins/canonical", nativeSource: undefined },
        { name: "conventional", path: "plugins/conventional", nativeSource: undefined },
        { name: "marketplace", path: "catalog/marketplace", nativeSource: undefined },
      ]));
      expect(candidates).toHaveLength(4);
    } finally {
      await rm(sourceRoot, { recursive: true, force: true });
    }
  });

  it("returns an empty catalog when a source has skills but no plugin markers", async () => {
    const sourceRoot = await mkdtemp(join(tmpdir(), "dotagents-plugin-catalog-"));
    try {
      await mkdir(join(sourceRoot, "skills", "review"), { recursive: true });
      await writeFile(join(sourceRoot, "skills", "review", "SKILL.md"), "# Review\n");

      await expect(discoverPlugins(sourceRoot)).resolves.toEqual([]);
    } finally {
      await rm(sourceRoot, { recursive: true, force: true });
    }
  });

  it("deduplicates a contained symlink alias and its physical plugin directory", async () => {
    const sourceRoot = await mkdtemp(join(tmpdir(), "dotagents-plugin-catalog-"));
    try {
      const pluginsDir = join(sourceRoot, "plugins");
      const pluginDir = join(pluginsDir, "review-tools");
      await mkdir(pluginDir, { recursive: true });
      await writeFile(join(pluginDir, "plugin.json"), JSON.stringify({ name: "review-tools" }));
      await symlink("review-tools", join(pluginsDir, "review-tools-alias"));

      const candidates = await discoverPlugins(sourceRoot);

      expect(candidates).toHaveLength(1);
      expect(candidates[0]!.name).toBe("review-tools");
    } finally {
      await rm(sourceRoot, { recursive: true, force: true });
    }
  });

  it("preserves distinct marketplace aliases for one nameless legacy plugin", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "dotagents-plugin-catalog-"));
    try {
      const sourceRoot = join(projectRoot, "source");
      const pluginDir = join(sourceRoot, "shared-plugin");
      await mkdir(pluginDir, { recursive: true });
      await writeFile(join(pluginDir, "plugin.json"), "{}");
      await writeFile(join(sourceRoot, "marketplace.json"), JSON.stringify({
        name: "aliases",
        plugins: [
          { name: "alpha", source: "./shared-plugin" },
          { name: "beta", source: "./shared-plugin" },
        ],
      }));

      const candidates = await discoverPlugins(sourceRoot);
      const alpha = await resolvePlugin(
        { name: "alpha", source: "path:source" },
        { stateDir: join(projectRoot, "state"), projectRoot },
      );
      const beta = await resolvePlugin(
        { name: "beta", source: "path:source" },
        { stateDir: join(projectRoot, "state"), projectRoot },
      );

      expect(candidates.map((candidate) => candidate.name).toSorted()).toEqual(["alpha", "beta"]);
      expect(alpha.plugin.pluginDir).toBe(pluginDir);
      expect(beta.plugin.pluginDir).toBe(pluginDir);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("preserves first-match ordering for repeated marketplace selectors", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "dotagents-plugin-catalog-"));
    try {
      const sourceRoot = join(projectRoot, "source");
      const pluginDir = join(sourceRoot, "review-tools");
      await mkdir(pluginDir, { recursive: true });
      await writeFile(join(pluginDir, "plugin.json"), "{}");
      await writeFile(join(sourceRoot, "marketplace.json"), JSON.stringify({
        name: "ordered",
        plugins: [
          { name: "review-tools", source: "./review-tools" },
          { name: "review-tools", source: "../outside" },
        ],
      }));

      await expect(resolvePlugin(
        { name: "review-tools", source: "path:source" },
        { stateDir: join(projectRoot, "state"), projectRoot },
      )).resolves.toMatchObject({ plugin: { pluginDir } });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("still scans below a manifestless marketplace target during named resolution", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "dotagents-plugin-catalog-"));
    try {
      const sourceRoot = join(projectRoot, "source");
      const pluginDir = join(sourceRoot, "plugins", "collection", "review-tools");
      await mkdir(pluginDir, { recursive: true });
      await writeFile(
        join(pluginDir, "plugin.json"),
        JSON.stringify({ name: "review-tools" }),
      );
      await writeFile(join(sourceRoot, "marketplace.json"), JSON.stringify({
        name: "catalog",
        plugins: [{ name: "collection", source: "./plugins/collection" }],
      }));

      await expect(discoverPlugins(sourceRoot)).rejects.toThrow(
        'Marketplace plugin "collection"',
      );
      await expect(resolvePlugin(
        { name: "review-tools", source: "path:source" },
        { stateDir: join(projectRoot, "state"), projectRoot },
      )).resolves.toMatchObject({ plugin: { pluginDir } });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("rejects malformed marketplace files with their path", async () => {
    const sourceRoot = await mkdtemp(join(tmpdir(), "dotagents-plugin-catalog-"));
    try {
      const marketplacePath = join(sourceRoot, "marketplace.json");
      await writeFile(marketplacePath, "{");

      await expect(discoverPlugins(sourceRoot)).rejects.toThrow(marketplacePath);
    } finally {
      await rm(sourceRoot, { recursive: true, force: true });
    }
  });

  it("rejects plugin bundle symlinks during strict discovery", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "dotagents-plugin-catalog-"));
    try {
      const sourceRoot = join(projectRoot, "source");
      const pluginDir = join(sourceRoot, "plugins", "review-tools");
      const outsideFile = join(projectRoot, "secret.txt");
      await mkdir(pluginDir, { recursive: true });
      await writeFile(join(pluginDir, "plugin.json"), JSON.stringify({ name: "review-tools" }));
      await writeFile(outsideFile, "secret");
      await symlink(outsideFile, join(pluginDir, "secret-link"));

      await expect(discoverPlugins(sourceRoot)).rejects.toThrow(
        "Plugin bundle symlink resolves outside the plugin directory",
      );
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("rejects local marketplace entries without a plugin manifest", async () => {
    const sourceRoot = await mkdtemp(join(tmpdir(), "dotagents-plugin-catalog-"));
    try {
      await mkdir(join(sourceRoot, "missing-manifest"), { recursive: true });
      await writeFile(join(sourceRoot, "marketplace.json"), JSON.stringify({
        name: "broken",
        plugins: [{ name: "broken", source: "./missing-manifest" }],
      }));

      await expect(discoverPlugins(sourceRoot)).rejects.toThrow(
        /Marketplace plugin "broken".*has no supported plugin manifest.*missing-manifest/,
      );
      await expect(discoverPlugins(sourceRoot, ["broken"])).rejects.toThrow(
        /Marketplace plugin "broken".*has no supported plugin manifest.*missing-manifest/,
      );
    } finally {
      await rm(sourceRoot, { recursive: true, force: true });
    }
  });

  it("uses an explicit dot path to select a same-named root plugin", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "dotagents-plugin-catalog-"));
    try {
      const sourceRoot = join(projectRoot, "source");
      const canonicalDir = join(sourceRoot, ".agents", "plugins", "shared");
      await mkdir(canonicalDir, { recursive: true });
      await writeFile(join(sourceRoot, "plugin.json"), JSON.stringify({ name: "shared" }));
      await writeFile(join(canonicalDir, "plugin.json"), JSON.stringify({ name: "shared" }));

      const explicitRoot = await resolvePlugin(
        { name: "shared", source: "path:source", path: "." },
        { stateDir: join(projectRoot, "state"), projectRoot },
      );
      const implicit = await resolvePlugin(
        { name: "shared", source: "path:source" },
        { stateDir: join(projectRoot, "state"), projectRoot },
      );

      expect(explicitRoot.plugin.pluginDir).toBe(sourceRoot);
      expect(implicit.plugin.pluginDir).toBe(canonicalDir);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});
