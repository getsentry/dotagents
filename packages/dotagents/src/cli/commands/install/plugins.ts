import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { AgentsConfig, PluginConfig } from "../../../config/schema.js";
import type { Lockfile } from "../../../lockfile/schema.js";
import type { ScopeRoot } from "../../../scope.js";
import {
  installPluginBundle,
  isInPlacePluginSource,
  isManagedPluginInstall,
  isProjectPluginSource,
  isSameProjectPluginConfig,
  loadInstalledPlugins,
  lockEntryForPlugin,
  type PluginDeclaration,
  pruneInstalledPlugins,
  resolvePlugin,
} from "../../../plugins/store.js";
import { GitError, TrustError } from "@sentry/dotagents-lib";
import { getCacheStateDir } from "../../cache.js";
import { InstallError } from "./errors.js";

export interface InstallPluginsResult {
  plugins: PluginDeclaration[];
  pruned: string[];
  lockEntries: Lockfile["plugins"];
}

function validateFrozenPlugins(
  plugins: PluginConfig[],
  lockfile: Lockfile | null,
): void {
  if (plugins.length === 0) {return;}
  if (!lockfile) {
    throw new InstallError("--frozen requires agents.lock to exist.");
  }

  for (const plugin of plugins) {
    if (!lockfile.plugins[plugin.name]) {
      throw new InstallError(
        `--frozen: plugin "${plugin.name}" is in agents.toml but missing from agents.lock.`,
      );
    }
  }
}

function staleManagedPluginNames(
  current: Lockfile | null,
  nextPlugins: Lockfile["plugins"],
): string[] {
  if (!current) {return [];}
  return Object.entries(current.plugins)
    .filter(([name, locked]) => !nextPlugins[name] && !isInPlacePluginSource(locked.source))
    .map(([name]) => name);
}

/** Ensures installs only replace plugin destinations already owned by dotagents. */
function assertPluginDestinationIsManaged(
  pluginsDir: string,
  plugin: PluginConfig,
  lockfile: Lockfile | null,
): void {
  const { name } = plugin;
  if (!existsSync(join(pluginsDir, name))) {return;}

  const locked = lockfile?.plugins[name];
  if (locked && !isInPlacePluginSource(locked.source)) {return;}
  if (locked && !isInPlacePluginSource(plugin.source)) {return;}
  if (isManagedPluginInstall(join(pluginsDir, name))) {return;}

  throw new InstallError(
    `Plugin "${name}" install destination already exists and is not managed by dotagents: ${join(pluginsDir, name)}`,
  );
}

/** Resolves, installs, and prunes canonical plugin bundles for install. */
export async function installPlugins(
  config: AgentsConfig,
  lockfile: Lockfile | null,
  scope: ScopeRoot,
  frozen?: boolean,
): Promise<InstallPluginsResult> {
  const plugins: PluginDeclaration[] = [];
  const pruned: string[] = [];
  const lockEntries: Lockfile["plugins"] = {};

  if (frozen) {
    validateFrozenPlugins(config.plugins, lockfile);
    const sameProjectPlugin = config.plugins.find((plugin) =>
      isSameProjectPluginConfig(plugin, scope.pluginsDir, scope.root)
    );
    if (sameProjectPlugin) {
      throw new InstallError(
        `Plugin "${sameProjectPlugin.name}" source resolves inside this project's .agents/plugins/ tree. ` +
          "Same-project plugins cannot be installed into the same project; use an external source path or a separate repo.",
      );
    }
    if (config.plugins.length > 0) {
      const loaded = await loadInstalledPlugins(scope.pluginsDir, config.plugins);
      if (loaded.issues.length > 0) {
        throw new InstallError(loaded.issues.join("\n"));
      }
      plugins.push(...loaded.plugins);
    }
    return { plugins, pruned, lockEntries };
  }

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
      assertPluginDestinationIsManaged(scope.pluginsDir, pluginConfig, lockfile);
      plugins.push(await installPluginBundle(scope.pluginsDir, resolved));
      lockEntries[resolved.plugin.name] = lockEntryForPlugin(resolved);
    }
  }

  if (lockfile) {
    pruned.push(...await pruneInstalledPlugins(
      scope.pluginsDir,
      staleManagedPluginNames(lockfile, lockEntries),
    ));
  }

  return { plugins, pruned, lockEntries };
}
