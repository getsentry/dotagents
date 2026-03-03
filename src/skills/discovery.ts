import { join } from "node:path";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { loadSkillMd, type SkillMeta } from "./loader.js";

export interface DiscoveredSkill {
  /** Relative path within the repo to the skill directory */
  path: string;
  meta: SkillMeta;
}

/** Conventional directories to scan for skills, in priority order. */
const SCAN_DIRS = [".", "skills", ".agents/skills", ".claude/skills"];

/**
 * Discover a specific skill by name within a repo directory.
 * Scans conventional directories in priority order.
 */
export async function discoverSkill(
  repoDir: string,
  skillName: string,
): Promise<DiscoveredSkill | null> {
  // Try each conventional directory by name match first (fast path)
  for (const scanDir of SCAN_DIRS) {
    const relPath = scanDir === "." ? skillName : `${scanDir}/${skillName}`;
    const skillMdPath = join(repoDir, relPath, "SKILL.md");
    if (existsSync(skillMdPath)) {
      try {
        const meta = await loadSkillMd(skillMdPath);
        return { path: relPath, meta };
      } catch {
        // Skip skills with invalid SKILL.md
      }
    }
  }

  // Fallback: scan conventional directories and match by frontmatter name.
  // This handles repos where the directory name differs from the skill name
  // (e.g. skills/chat/SKILL.md with name: "chat-sdk").
  for (const scanDir of SCAN_DIRS) {
    const absDir = join(repoDir, scanDir);
    if (!existsSync(absDir)) {continue;}

    let entries;
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {continue;}
      const skillMdPath = join(absDir, entry.name, "SKILL.md");
      if (!existsSync(skillMdPath)) {continue;}

      try {
        const meta = await loadSkillMd(skillMdPath);
        if (meta.name === skillName) {
          const relPath = scanDir === "." ? entry.name : `${scanDir}/${entry.name}`;
          return { path: relPath, meta };
        }
      } catch {
        // Skip skills with invalid SKILL.md
      }
    }
  }

  // Marketplace format: check .claude-plugin/marketplace.json
  const marketplaceSkill = await tryMarketplaceFormat(repoDir, skillName);
  if (marketplaceSkill) {return marketplaceSkill;}

  return null;
}

/**
 * Discover all skills in a repo.
 * Scans conventional directories and returns everything found.
 */
export async function discoverAllSkills(
  repoDir: string,
): Promise<DiscoveredSkill[]> {
  const found = new Map<string, DiscoveredSkill>();

  // Scan each conventional directory for directories containing SKILL.md
  for (const scanDir of SCAN_DIRS) {
    const absDir = join(repoDir, scanDir);
    if (!existsSync(absDir)) {continue;}

    let entries;
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {continue;}
      const skillMdPath = join(absDir, entry.name, "SKILL.md");
      if (!existsSync(skillMdPath)) {continue;}

      // First match wins (higher priority dirs are scanned first)
      if (found.has(entry.name)) {continue;}

      try {
        const meta = await loadSkillMd(skillMdPath);
        const relPath = scanDir === "." ? entry.name : `${scanDir}/${entry.name}`;
        found.set(entry.name, { path: relPath, meta });
      } catch {
        // Skip skills with invalid SKILL.md
      }
    }
  }

  // Marketplace format: plugins/*/skills/*/SKILL.md
  const marketplaceSkills = await scanMarketplaceFormat(repoDir);
  for (const skill of marketplaceSkills) {
    if (!found.has(skill.meta.name)) {
      found.set(skill.meta.name, skill);
    }
  }

  return [...found.values()];
}

async function scanMarketplaceFormat(
  repoDir: string,
): Promise<DiscoveredSkill[]> {
  const pluginsDir = join(repoDir, ".claude-plugin");
  if (!existsSync(pluginsDir)) {return [];}

  const pluginsDirPath = join(repoDir, "plugins");
  if (!existsSync(pluginsDirPath)) {return [];}

  let plugins;
  try {
    plugins = await readdir(pluginsDirPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const results: DiscoveredSkill[] = [];
  for (const plugin of plugins) {
    if (!plugin.isDirectory()) {continue;}
    const skillsDir = join(pluginsDirPath, plugin.name, "skills");
    if (!existsSync(skillsDir)) {continue;}

    let skillEntries;
    try {
      skillEntries = await readdir(skillsDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of skillEntries) {
      if (!entry.isDirectory()) {continue;}
      const skillMdPath = join(skillsDir, entry.name, "SKILL.md");
      if (!existsSync(skillMdPath)) {continue;}

      try {
        const meta = await loadSkillMd(skillMdPath);
        results.push({
          path: `plugins/${plugin.name}/skills/${entry.name}`,
          meta,
        });
      } catch {
        // Skip invalid
      }
    }
  }

  return results;
}

async function tryMarketplaceFormat(
  repoDir: string,
  skillName: string,
): Promise<DiscoveredSkill | null> {
  const pluginsDir = join(repoDir, ".claude-plugin");
  if (!existsSync(pluginsDir)) {return null;}

  // Scan plugins/*/skills/<name>/SKILL.md
  const pluginsDirPath = join(repoDir, "plugins");
  if (!existsSync(pluginsDirPath)) {return null;}

  let plugins;
  try {
    plugins = await readdir(pluginsDirPath, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const plugin of plugins) {
    if (!plugin.isDirectory()) {continue;}
    const skillMdPath = join(pluginsDirPath, plugin.name, "skills", skillName, "SKILL.md");
    if (!existsSync(skillMdPath)) {continue;}

    try {
      const meta = await loadSkillMd(skillMdPath);
      return { path: `plugins/${plugin.name}/skills/${skillName}`, meta };
    } catch {
      // Skip skills with invalid SKILL.md
    }
  }

  return null;
}
