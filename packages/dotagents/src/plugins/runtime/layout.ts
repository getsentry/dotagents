import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ScopeRoot } from "../../scope.js";

export interface PluginRuntimeLayout {
  claudeMarketplaceRoot: string;
  cursorMarketplaceRoot: string;
  codexMarketplaceRoot: string;
  claudeMarketplacePath: string;
  cursorMarketplacePath: string;
  codexMarketplacePath: string;
  canonicalPluginsDir: string;
  grokPluginsDir: string;
  opencodeSkillsDir: string;
  opencodeAgentsDir: string;
  piSkillsDir: string;
}

export type PluginRuntimeRoot = string | PluginRuntimeLayout;

export function projectPluginRuntimeLayout(root: string): PluginRuntimeLayout {
  return {
    claudeMarketplaceRoot: root,
    cursorMarketplaceRoot: root,
    codexMarketplaceRoot: root,
    claudeMarketplacePath: join(root, ".claude-plugin", "marketplace.json"),
    cursorMarketplacePath: join(root, ".cursor-plugin", "marketplace.json"),
    codexMarketplacePath: join(root, ".agents", "plugins", "marketplace.json"),
    canonicalPluginsDir: join(root, ".agents", "plugins"),
    grokPluginsDir: join(root, ".grok", "plugins"),
    opencodeSkillsDir: join(root, ".opencode", "skills"),
    opencodeAgentsDir: join(root, ".opencode", "agents"),
    piSkillsDir: join(root, ".agents", "skills"),
  };
}

export function userPluginRuntimeLayout(root: string): PluginRuntimeLayout {
  const home = homedir();
  const defaultRoot = join(home, ".agents");
  const usesDefaultRoot = resolve(root) === resolve(defaultRoot);
  return {
    claudeMarketplaceRoot: root,
    cursorMarketplaceRoot: root,
    codexMarketplaceRoot: usesDefaultRoot ? home : root,
    claudeMarketplacePath: join(root, ".claude-plugin", "marketplace.json"),
    cursorMarketplacePath: join(root, ".cursor-plugin", "marketplace.json"),
    codexMarketplacePath: usesDefaultRoot
      ? join(root, "plugins", "marketplace.json")
      : join(root, ".agents", "plugins", "marketplace.json"),
    canonicalPluginsDir: join(root, "plugins"),
    grokPluginsDir: join(home, ".grok", "plugins"),
    opencodeSkillsDir: join(home, ".config", "opencode", "skills"),
    opencodeAgentsDir: join(home, ".config", "opencode", "agents"),
    piSkillsDir: join(root, "skills"),
  };
}

export function pluginRuntimeLayout(scope: ScopeRoot): PluginRuntimeLayout {
  return scope.scope === "user"
    ? userPluginRuntimeLayout(scope.root)
    : projectPluginRuntimeLayout(scope.root);
}

export function normalizePluginRuntimeLayout(root: PluginRuntimeRoot): PluginRuntimeLayout {
  return typeof root === "string" ? projectPluginRuntimeLayout(root) : root;
}
