import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_PLUGIN_SCHEMA,
  discoverAllSkills,
  discoverPlugins,
  resolvePlugin,
} from "@sentry/dotagents-lib";

const root = await mkdtemp(join(tmpdir(), "dotagents-plugin-consumer-"));
try {
  const pluginDir = join(root, "source", "plugins", "review-tools");
  await mkdir(join(pluginDir, "skills", "review"), { recursive: true });
  await writeFile(join(pluginDir, "plugin.json"), JSON.stringify({
    $schema: AGENT_PLUGIN_SCHEMA,
    name: "review-tools",
  }));
  await writeFile(join(pluginDir, "skills", "review", "SKILL.md"),
    "---\nname: review\ndescription: Review changes\n---\n");

  const resolved = await resolvePlugin(
    { name: "review-tools", source: "path:source" },
    { projectRoot: root, stateDir: join(root, "state") },
  );
  assert.equal(resolved.plugin.pluginDir, pluginDir);
  assert.equal(resolved.plugin.manifest.name, "review-tools");
  assert.deepEqual(
    (await discoverAllSkills(join(resolved.plugin.pluginDir, "skills"), { scanDirs: [] }))
      .filter(({ path }) => path !== "." && !path.includes("/"))
      .map(({ meta }) => meta.name),
    ["review"],
  );
  assert.deepEqual(await discoverPlugins(join(root, "source"), ["missing"]), []);
  console.log("verify-pack: external plugin resolver consumer OK");
} finally {
  await rm(root, { recursive: true, force: true });
}
