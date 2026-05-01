import { join } from "node:path";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { loadSkillMd, type SkillMeta } from "./loader.js";

export interface DiscoveredSkill {
  /** Relative path within the repo to the skill directory */
  path: string;
  meta: SkillMeta;
}

/**
 * Conventional directories to scan for skills, in priority order.
 * The root dir (".") is scanned flat (direct children only) to avoid
 * walking the entire repo. Other dirs are scanned recursively to handle
 * categorized layouts like skills/.curated/<name>/.
 *
 * Lib default is the canonical agentskills.io layout (`skills/`). Hosts
 * with their own conventions (e.g. dotagents' `.agents/skills/`, Claude
 * Code's `.claude/skills/`) pass them via the `scanDirs` option.
 */
const ROOT_SCAN_DIR = ".";
const DEFAULT_RECURSIVE_SCAN_DIRS: readonly string[] = ["skills"];

export interface DiscoveryOpts {
  /** Recursive scan dirs, in priority order. Defaults to `["skills"]`. */
  scanDirs?: readonly string[];
}

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

/** All scan dirs in priority order, with their scan mode. */
function buildScanDirs(opts?: DiscoveryOpts): Array<{ dir: string; recursive: boolean }> {
  const recursive = opts?.scanDirs ?? DEFAULT_RECURSIVE_SCAN_DIRS;
  return [
    { dir: ROOT_SCAN_DIR, recursive: false },
    ...recursive.map((dir) => ({ dir, recursive: true })),
  ];
}

/**
 * List skill directories within a scan dir.
 * Root dir is scanned flat; other dirs are walked recursively.
 */
async function listSkillDirs(
  repoDir: string,
  scanDir: string,
  recursive: boolean,
): Promise<SkillDir[]> {
  const absDir = join(repoDir, scanDir);
  if (recursive) {return walkSkillDirs(absDir);}

  // Flat scan: only direct children with SKILL.md
  if (!existsSync(absDir)) {return [];}
  let entries;
  try {
    entries = await readdir(absDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const results: SkillDir[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {continue;}
    const absPath = join(absDir, entry.name);
    if (existsSync(join(absPath, "SKILL.md"))) {
      results.push({ absPath, relPath: entry.name });
    }
  }

  // Check if the root directory itself is a skill (single-skill repo pattern)
  if (scanDir === ROOT_SCAN_DIR && existsSync(join(absDir, "SKILL.md"))) {
    results.push({ absPath: absDir, relPath: "." });
  }

  return results;
}

/**
 * Discover a specific skill by name within a repo directory.
 * Scans conventional directories in priority order, recursing into
 * subdirectories until SKILL.md is found.
 */
export async function discoverSkill(
  repoDir: string,
  skillName: string,
  opts?: DiscoveryOpts,
): Promise<DiscoveredSkill | null> {
  for (const { dir: scanDir, recursive } of buildScanDirs(opts)) {
    const skillDirs = await listSkillDirs(repoDir, scanDir, recursive);

    // Within each scan dir: prefer dir-name match, fall back to frontmatter match
    let dirNameMatch: DiscoveredSkill | null = null;
    let frontmatterMatch: DiscoveredSkill | null = null;

    for (const { absPath, relPath } of skillDirs) {
      const dirName = relPath.split("/").pop()!;
      const fullRelPath = scanDir === ROOT_SCAN_DIR ? relPath : `${scanDir}/${relPath}`;

      try {
        const meta = await loadSkillMd(join(absPath, "SKILL.md"));
        if (!dirNameMatch && dirName === skillName) {
          dirNameMatch = { path: fullRelPath, meta };
        } else if (!frontmatterMatch && meta.name === skillName) {
          frontmatterMatch = { path: fullRelPath, meta };
        }
      } catch {
        // Skip skills with invalid SKILL.md
      }
    }

    // Any match in this scan dir wins over later scan dirs
    if (dirNameMatch) {return dirNameMatch;}
    if (frontmatterMatch) {return frontmatterMatch;}
  }

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
  opts?: DiscoveryOpts,
): Promise<DiscoveredSkill[]> {
  const found = new Map<string, DiscoveredSkill>();

  for (const { dir: scanDir, recursive } of buildScanDirs(opts)) {
    const skillDirs = await listSkillDirs(repoDir, scanDir, recursive);

    for (const { absPath, relPath } of skillDirs) {
      try {
        const meta = await loadSkillMd(join(absPath, "SKILL.md"));
        // First match wins (higher priority scan dirs are checked first)
        if (found.has(meta.name)) {continue;}
        const fullRelPath = scanDir === ROOT_SCAN_DIR ? relPath : `${scanDir}/${relPath}`;
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
