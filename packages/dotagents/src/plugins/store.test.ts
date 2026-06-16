import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
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

  it("skips unsupported marketplace sources during discovery", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "dotagents-plugin-store-"));
    try {
      const pluginDir = join(projectRoot, "plugins", "review-tools");
      const marketplaceOnlyDir = join(projectRoot, "plugins", "marketplace-review-tools");
      await mkdir(pluginDir, { recursive: true });
      await mkdir(marketplaceOnlyDir, { recursive: true });
      await writeFile(
        join(projectRoot, "marketplace.json"),
        JSON.stringify({
          name: "test-marketplace",
          plugins: [
            {
              name: "review-tools",
              source: { source: "github", path: "plugins/marketplace-review-tools" },
            },
          ],
        }),
        "utf-8",
      );
      await writeFile(
        join(marketplaceOnlyDir, "plugin.json"),
        JSON.stringify({ name: "review-tools", description: "Marketplace-only plugin" }),
        "utf-8",
      );
      await writeFile(
        join(pluginDir, "plugin.json"),
        JSON.stringify({ name: "review-tools", description: "Fallback local plugin" }),
        "utf-8",
      );

      const resolved = await resolvePlugin(
        { name: "review-tools", source: "path:." },
        { stateDir: join(projectRoot, "state"), projectRoot },
      );

      expect(resolved.plugin.pluginDir).toBe(pluginDir);
      expect(resolved.plugin.manifest.description).toBe("Fallback local plugin");
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});
