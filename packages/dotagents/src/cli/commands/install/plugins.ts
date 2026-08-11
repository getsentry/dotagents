import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PLUGIN_NAME_PATTERN, type AgentsConfig } from "../../../config/schema.js";
import type { Lockfile } from "../../../lockfile/schema.js";
import type { ScopeRoot } from "../../../scope.js";
import {
  installPluginBundle,
  isInPlacePluginSource,
  isManagedPluginInstall,
  isProjectPluginSource,
  lockEntryForPlugin,
  pruneInstalledPlugins,
  resolvePlugin,
} from "../../../plugins/store.js";
import type { PluginDeclaration } from "../../../plugins/types.js";
import { GitError, TrustError, type CacheReuse } from "@sentry/dotagents-lib";
import { getCacheStateDir } from "../../cache.js";
import { InstallError } from "./errors.js";

export interface InstallPluginsResult {
  plugins: PluginDeclaration[];
  pruned: string[];
  staleManaged: string[];
  lockEntries: Lockfile["plugins"];
}

function staleManagedPluginNames(
  current: Lockfile | null,
  nextPlugins: Lockfile["plugins"],
): string[] {
  if (!current) {return [];}
  return Object.entries(current.plugins)
    .filter(([name, locked]) => (
      PLUGIN_NAME_PATTERN.test(name) &&
      !nextPlugins[name] &&
      !isInPlacePluginSource(locked.source)
    ))
    .map(([name]) => name);
}

/** Ensures installs only replace plugin destinations already owned by dotagents. */
async function assertPluginDestinationIsManaged(
  pluginsDir: string,
  name: string,
): Promise<void> {
  if (!existsSync(join(pluginsDir, name))) {return;}
  if (await isManagedPluginInstall(join(pluginsDir, name))) {return;}

  throw new InstallError(
    `Plugin "${name}" install destination already exists and is not managed by dotagents: ${join(pluginsDir, name)}`,
  );
}

/** Resolves, installs, and prunes canonical plugin bundles for install. */
export async function installPlugins(
  config: AgentsConfig,
  lockfile: Lockfile | null,
  scope: ScopeRoot,
  reuse?: CacheReuse,
): Promise<InstallPluginsResult> {
  const plugins: PluginDeclaration[] = [];
  const pruned: string[] = [];
  const lockEntries: Lockfile["plugins"] = {};

  if (config.plugins.length > 0) {
    await mkdir(scope.pluginsDir, { recursive: true });
    for (const pluginConfig of config.plugins) {
      let resolved: Awaited<ReturnType<typeof resolvePlugin>>;
      try {
        resolved = await resolvePlugin(pluginConfig, {
          stateDir: getCacheStateDir(),
          projectRoot: scope.root,
          defaultRepositorySource: config.defaultRepositorySource,
          minimumReleaseAge: config.minimum_release_age,
          minimumReleaseAgeExclude: config.minimum_release_age_exclude,
          trust: config.trust,
          reuse,
        });
      } catch (err) {
        if (err instanceof GitError || err instanceof TrustError) {throw err;}
        const msg = err instanceof Error ? err.message : String(err);
        throw new InstallError(`Failed to resolve plugin "${pluginConfig.name}": ${msg}`);
      }
      if (isProjectPluginSource(resolved.plugin.pluginDir, scope.pluginsDir)) {
        throw new InstallError(
          `Plugin "${resolved.plugin.name}" source resolves inside this project's .agents/plugins/ tree. ` +
            "Same-project plugins cannot be installed into the same project; use an external source path or a separate repo.",
        );
      }
      await assertPluginDestinationIsManaged(scope.pluginsDir, pluginConfig.name);
      plugins.push(await installPluginBundle(scope.pluginsDir, resolved));
      lockEntries[resolved.plugin.name] = lockEntryForPlugin(resolved);
    }
  }

  const staleManaged = staleManagedPluginNames(lockfile, lockEntries);
  if (lockfile) {
    pruned.push(...await pruneInstalledPlugins(
      scope.pluginsDir,
      staleManaged,
    ));
  }

  return { plugins, pruned, staleManaged, lockEntries };
}
