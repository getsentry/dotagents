import { mkdtemp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { isSameProjectPluginConfig, lockEntryForPlugin, type ResolvedPlugin } from "./store.js";

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
});
