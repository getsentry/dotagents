import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { resolveProjectPath, type ScopeRoot } from "../../scope.js";
import { isString } from "../../utils/type-guards.js";

export interface PluginRuntimeLayout {
  claudeMarketplaceRoot: string;
  copilotMarketplaceRoot: string;
  cursorMarketplaceRoot: string;
  codexMarketplaceRoot: string;
  claudeMarketplacePath: string;
  copilotMarketplacePath: string;
  cursorMarketplacePath: string;
  codexMarketplacePath: string;
  canonicalPluginsDir: string;
  grokPluginsDir: string;
  opencodeSkillsDir: string;
  opencodeAgentsDir: string;
  opencodeMcpPath: string;
  opencodeMcpStatePath: string;
  pluginDataDir: string;
  piSkillsDir: string;
}

export type PluginRuntimeRoot = string | PluginRuntimeLayout;

export function projectPluginRuntimeLayout(root: string): PluginRuntimeLayout {
  const opencodeCandidates = [
    join(root, ".opencode", "opencode.jsonc"),
    join(root, ".opencode", "opencode.json"),
    join(root, "opencode.jsonc"),
    join(root, "opencode.json"),
  ];
  const opencodeMcpPath = opencodeCandidates.find((path) => existsSync(path))
    ?? opencodeCandidates[0]!;
  return {
    claudeMarketplaceRoot: root,
    copilotMarketplaceRoot: root,
    cursorMarketplaceRoot: root,
    codexMarketplaceRoot: root,
    claudeMarketplacePath: resolveProjectPath(root, ".claude-plugin/marketplace.json"),
    copilotMarketplacePath: resolveProjectPath(root, ".github/plugin/marketplace.json"),
    cursorMarketplacePath: resolveProjectPath(root, ".cursor-plugin/marketplace.json"),
    codexMarketplacePath: resolveProjectPath(root, ".agents/plugins/marketplace.json"),
    canonicalPluginsDir: resolveProjectPath(root, ".agents/plugins"),
    grokPluginsDir: resolveProjectPath(root, ".grok/plugins"),
    opencodeSkillsDir: resolveProjectPath(root, ".opencode/skills"),
    opencodeAgentsDir: resolveProjectPath(root, ".opencode/agents"),
    opencodeMcpPath: resolveProjectPath(root, relative(root, opencodeMcpPath)),
    opencodeMcpStatePath: resolveProjectPath(root, ".agents/plugin-mcp/opencode.json"),
    pluginDataDir: resolveProjectPath(root, ".agents/plugin-data"),
    piSkillsDir: resolveProjectPath(root, ".agents/skills"),
  };
}

export function userPluginRuntimeLayout(root: string): PluginRuntimeLayout {
  const home = homedir();
  const defaultRoot = join(home, ".agents");
  const usesDefaultRoot = resolve(root) === resolve(defaultRoot);
  return {
    claudeMarketplaceRoot: root,
    copilotMarketplaceRoot: root,
    cursorMarketplaceRoot: root,
    codexMarketplaceRoot: usesDefaultRoot ? home : root,
    claudeMarketplacePath: join(root, ".claude-plugin", "marketplace.json"),
    copilotMarketplacePath: join(root, ".github", "plugin", "marketplace.json"),
    cursorMarketplacePath: join(root, ".cursor-plugin", "marketplace.json"),
    codexMarketplacePath: usesDefaultRoot
      ? join(root, "plugins", "marketplace.json")
      : join(root, ".agents", "plugins", "marketplace.json"),
    canonicalPluginsDir: join(root, "plugins"),
    grokPluginsDir: join(home, ".grok", "plugins"),
    opencodeSkillsDir: join(home, ".config", "opencode", "skills"),
    opencodeAgentsDir: join(home, ".config", "opencode", "agents"),
    opencodeMcpPath: join(home, ".config", "opencode", "opencode.json"),
    opencodeMcpStatePath: join(root, "plugin-mcp", "opencode.json"),
    pluginDataDir: join(root, "plugin-data"),
    piSkillsDir: join(root, "skills"),
  };
}

export function pluginRuntimeLayout(scope: ScopeRoot): PluginRuntimeLayout {
  return scope.scope === "user"
    ? userPluginRuntimeLayout(scope.root)
    : projectPluginRuntimeLayout(scope.root);
}

export function normalizePluginRuntimeLayout(root: PluginRuntimeRoot): PluginRuntimeLayout {
  return isString(root) ? projectPluginRuntimeLayout(root) : root;
}
