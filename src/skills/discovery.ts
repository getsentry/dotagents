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

interface SkillDir {
  /** Absolute path to the directory containing SKILL.md */
  absPath: string;
  /** Relative path from the scan root to this directory */
  relPath: string;
}

/**
 * Recursively walk a directory tree finding all directories that contain SKILL.md.
 * Stops descending into a directory once SKILL.md is found (skill dirs are leaf nodes).
 */
async function walkSkillDirs(baseDir: string, relPrefix = ""): Promise<SkillDir[]> {
  if (!existsSync(baseDir)) {return [];}

  let entries;
  try {
    entries = await readdir(baseDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const direct: SkillDir[] = [];
  const nested: SkillDir[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {continue;}
    const absPath = join(baseDir, entry.name);
    const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;

    if (existsSync(join(absPath, "SKILL.md"))) {
      // This is a skill directory — collect it and don't descend further
      direct.push({ absPath, relPath });
    } else {
      // Not a skill — recurse into it to find nested skills
      const children = await walkSkillDirs(absPath, relPath);
      nested.push(...children);
    }
  }
  // Direct children first, then nested — shallower matches have priority
  return [...direct, ...nested];
}

/**
 * Discover a specific skill by name within a repo directory.
 * Scans conventional directories in priority order, recursing into
 * subdirectories until SKILL.md is found.
 */
export async function discoverSkill(
  repoDir: string,
  skillName: string,
): Promise<DiscoveredSkill | null> {
  // Walk once per scan dir, check dir name match first then frontmatter match
  let frontmatterMatch: DiscoveredSkill | null = null;

  for (const scanDir of SCAN_DIRS) {
    const absDir = join(repoDir, scanDir);
    const skillDirs = await walkSkillDirs(absDir);

    for (const { absPath, relPath } of skillDirs) {
      const dirName = relPath.split("/").pop()!;
      const fullRelPath = scanDir === "." ? relPath : `${scanDir}/${relPath}`;

      try {
        const meta = await loadSkillMd(join(absPath, "SKILL.md"));
        if (dirName === skillName) {
          return { path: fullRelPath, meta };
        }
        if (!frontmatterMatch && meta.name === skillName) {
          frontmatterMatch = { path: fullRelPath, meta };
        }
      } catch {
        // Skip skills with invalid SKILL.md
      }
    }
  }

  if (frontmatterMatch) {return frontmatterMatch;}

  // Marketplace format
  const marketplaceSkill = await tryMarketplaceFormat(repoDir, skillName);
  if (marketplaceSkill) {return marketplaceSkill;}

  return null;
}

/**
 * Discover all skills in a repo.
 * Scans conventional directories recursively and returns everything found.
 */
export async function discoverAllSkills(
  repoDir: string,
): Promise<DiscoveredSkill[]> {
  const found = new Map<string, DiscoveredSkill>();

  for (const scanDir of SCAN_DIRS) {
    const absDir = join(repoDir, scanDir);
    const skillDirs = await walkSkillDirs(absDir);

    for (const { absPath, relPath } of skillDirs) {
      try {
        const meta = await loadSkillMd(join(absPath, "SKILL.md"));
        // First match wins (higher priority scan dirs are checked first)
        if (found.has(meta.name)) {continue;}
        const fullRelPath = scanDir === "." ? relPath : `${scanDir}/${relPath}`;
        found.set(meta.name, { path: fullRelPath, meta });
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
