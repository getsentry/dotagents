import { readFile } from "node:fs/promises";
import { parse as parseTOML } from "smol-toml";
import { agentsConfigSchema, isWildcardDep, type AgentsConfig } from "./schema.js";
import { allAgentIds } from "../targets/registry.js";
import { allPluginOnlyAgentIds } from "../plugins/targets.js";
import { applyDefaultRepositorySource, parseSource } from "@sentry/dotagents-lib";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export async function loadConfig(filePath: string): Promise<AgentsConfig> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch {
    throw new ConfigError(`Config file not found: ${filePath}`);
  }

  let parsed: unknown;
  try {
    parsed = parseTOML(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ConfigError(`Invalid TOML in ${filePath}: ${message}`);
  }

  const result = agentsConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new ConfigError(`Invalid config in ${filePath}:\n${issues}`);
  }

  // Post-parse validation: reject unknown agent IDs
  const registryAgentIds = allAgentIds();
  const validIds = [...new Set([...registryAgentIds, ...allPluginOnlyAgentIds()])];
  const unknown = result.data.agents.filter((id) => !validIds.includes(id));
  if (unknown.length > 0) {
    throw new ConfigError(
      `Unknown agent(s) in ${filePath}: ${unknown.join(", ")}. Valid agents: ${validIds.join(", ")}`,
    );
  }

  const unknownSubagentTargets = [
    ...new Set(
      result.data.subagents.flatMap((subagent) =>
        (subagent.targets ?? []).filter((id) => !registryAgentIds.includes(id))
      ),
    ),
  ];
  if (unknownSubagentTargets.length > 0) {
    throw new ConfigError(
      `Unknown subagent target(s) in ${filePath}: ${unknownSubagentTargets.join(", ")}. Valid agents: ${registryAgentIds.join(", ")}`,
    );
  }

  const unknownPluginTargets = [
    ...new Set(
      result.data.plugins.flatMap((plugin) =>
        (plugin.targets ?? []).filter((id) => !validIds.includes(id))
      ),
    ),
  ];
  if (unknownPluginTargets.length > 0) {
    throw new ConfigError(
      `Unknown plugin target(s) in ${filePath}: ${unknownPluginTargets.join(", ")}. Valid agents: ${validIds.join(", ")}`,
    );
  }

  for (const subagent of result.data.subagents) {
    const sourceForResolve = applyDefaultRepositorySource(
      subagent.source,
      result.data.defaultRepositorySource,
    );
    if (parseSource(sourceForResolve).type === "well-known") {
      throw new ConfigError(
        `Subagent "${subagent.name}" uses an unsupported HTTPS well-known source in ${filePath}. Use a git: URL, GitHub/GitLab repository, or path: source.`,
      );
    }
  }

  for (const plugin of result.data.plugins) {
    const sourceForResolve = applyDefaultRepositorySource(
      plugin.source,
      result.data.defaultRepositorySource,
    );
    if (parseSource(sourceForResolve).type === "well-known") {
      throw new ConfigError(
        `Plugin "${plugin.name}" uses an unsupported HTTPS well-known source in ${filePath}. Use a git: URL, GitHub/GitLab repository, or path: source.`,
      );
    }
  }

  // Post-parse validation: no two wildcard entries may share the same source
  const wildcardSources = new Set<string>();
  for (const dep of result.data.skills) {
    if (isWildcardDep(dep)) {
      if (wildcardSources.has(dep.source)) {
        throw new ConfigError(
          `Duplicate wildcard source in ${filePath}: "${dep.source}". Only one name = "*" entry per source is allowed.`,
        );
      }
      wildcardSources.add(dep.source);
    }
  }

  // Post-parse validation: no two subagent entries may share the same name.
  const subagentNames = new Set<string>();
  for (const subagent of result.data.subagents) {
    if (subagentNames.has(subagent.name)) {
      throw new ConfigError(
        `Duplicate subagent in ${filePath}: "${subagent.name}". Subagent names must be unique.`,
      );
    }
    subagentNames.add(subagent.name);
  }

  // Post-parse validation: no two plugin entries may share the same name.
  const pluginNames = new Set<string>();
  for (const plugin of result.data.plugins) {
    if (pluginNames.has(plugin.name)) {
      throw new ConfigError(
        `Duplicate plugin in ${filePath}: "${plugin.name}". Plugin names must be unique.`,
      );
    }
    pluginNames.add(plugin.name);
  }

  return result.data;
}
