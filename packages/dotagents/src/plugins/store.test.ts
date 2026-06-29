import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { isSameProjectPluginConfig, lockEntryForPlugin, resolvePlugin, type ResolvedPlugin } from "./store.js";

describe("plugin store", () => {
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
});
