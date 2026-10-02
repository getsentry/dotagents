import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENT_PLUGIN_SCHEMA } from "./schema.js";
import { discoverPlugins, loadInstalledPluginBundle, resolvePlugin } from "./resolver.js";
import { discoverAllSkills } from "../skills/discovery.js";

// The host package covers discovery precedence and install behavior in depth.
// These tests pin the library contract that non-dotagents hosts depend on.
describe("plugin resolver library contract", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "dotagents-lib-plugins-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("resolves and loads a skill-only plugin without host config", async () => {
    const pluginDir = join(root, "source", "plugins", "review-tools");
    await mkdir(join(pluginDir, "skills", "review"), { recursive: true });
    await writeFile(
      join(pluginDir, "plugin.json"),
      JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA, name: "review-tools", description: "Review helpers" }),
    );
    await writeFile(join(pluginDir, "skills", "review", "SKILL.md"), "---\nname: review\ndescription: Review\n---\n");
    await mkdir(join(pluginDir, "skills", "category", "nested"), { recursive: true });
    await writeFile(join(pluginDir, "skills", "category", "nested", "SKILL.md"),
      "---\nname: nested\ndescription: Not an immediate child\n---\n");
    await writeFile(join(pluginDir, "skills", "SKILL.md"),
      "---\nname: root\ndescription: Not an immediate child\n---\n");

    const resolved = await resolvePlugin(
      { name: "review-tools", source: "path:source" },
      { stateDir: join(root, "state"), projectRoot: root },
    );

    expect(resolved).toEqual({
      type: "local",
      plugin: {
        name: "review-tools",
        source: "path:source",
        pluginDir,
        manifest: { $schema: AGENT_PLUGIN_SCHEMA, name: "review-tools", description: "Review helpers" },
        authoredNativeInterfaces: {},
        nativeSource: undefined,
      },
    });
    const skills = (await discoverAllSkills(join(resolved.plugin.pluginDir, "skills"), { scanDirs: [] }))
      .filter(({ path }) => path !== "." && !path.includes("/"));
    expect(skills.map(({ meta }) => meta.name)).toEqual(["review"]);
  });

  it("resolves a manifest-less root marketplace plugin without the host", async () => {
    const sourceDir = join(root, "source");
    await mkdir(join(sourceDir, ".claude-plugin"), { recursive: true });
    await mkdir(join(sourceDir, "skills", "agent-browser"), { recursive: true });
    await writeFile(join(sourceDir, "skills", "agent-browser", "SKILL.md"),
      "---\nname: agent-browser\ndescription: Browse\n---\n");
    await writeFile(join(sourceDir, ".claude-plugin", "marketplace.json"), JSON.stringify({
      name: "agent-browser",
      plugins: [{ name: "agent-browser", source: "./", strict: false, skills: ["./skills/agent-browser"] }],
    }));

    const resolved = await resolvePlugin(
      { name: "agent-browser", source: "path:source", path: "." },
      { stateDir: join(root, "state"), projectRoot: root },
    );
    expect(resolved.plugin).toMatchObject({
      name: "agent-browser",
      pluginDir: sourceDir,
      manifest: { name: "agent-browser", skills: ["./skills/agent-browser"] },
      nativeSource: "claude",
    });
  });

  it("filters requested names without returning unrelated plugins", async () => {
    for (const name of ["alpha", "beta"]) {
      const pluginDir = join(root, "plugins", name);
      await mkdir(pluginDir, { recursive: true });
      await writeFile(join(pluginDir, "plugin.json"), JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA, name }));
    }

    const names = async (requested?: string[]) =>
      (await discoverPlugins(root, requested)).map((candidate) => candidate.name).toSorted();

    expect(await names(["alpha"])).toEqual(["alpha"]);
    expect(await names(["alpha", "missing"])).toEqual(["alpha"]);
    expect(await names(["missing"])).toEqual([]);
    expect(await names()).toEqual(["alpha", "beta"]);
  });

  it("checks installed bundle containment before reading host provenance", async () => {
    const pluginsDir = join(root, "installed");
    const outsideDir = join(root, "outside");
    await mkdir(pluginsDir, { recursive: true });
    await mkdir(outsideDir, { recursive: true });
    await writeFile(join(outsideDir, "plugin.json"), JSON.stringify({ name: "escape" }));
    await symlink(outsideDir, join(pluginsDir, "escape"));

    let provenanceReads = 0;
    await expect(loadInstalledPluginBundle(pluginsDir, join(pluginsDir, "escape"), "escape", async () => {
      provenanceReads += 1;
      return { fallbackSources: null };
    })).rejects.toThrow("Installed plugin resolves outside source: escape");
    expect(provenanceReads).toBe(0);
  });
});
