import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readlink, realpath, rename, rm, symlink, unlink } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { hasErrorCode } from "../utils/type-guards.js";
import { managedSkillPath } from "../utils/fs.js";
import { SymlinkError } from "./manager.js";
import { isWildcardDep, type SkillDependency } from "../config/schema.js";
import type { Lockfile } from "../lockfile/schema.js";

/**
 * Entries a client manages itself inside its skills directory. They are never moved into the
 * shared directory or replaced with links. Claude Code downloads skills enabled on claude.ai
 * into `synced/`, moves them to `.trash/` when syncing stops, and stages downloads in `.staging/`.
 */
const CLIENT_OWNED_ENTRIES = new Set(["synced", ".trash", ".staging"]);

export interface SkillLinksResult {
  /** Skills linked into the client directory in this run. */
  linked: string[];
  /** Skill directories written by the client and moved into the shared directory. */
  adopted: string[];
  /** Links removed because their shared skill no longer exists. */
  pruned: string[];
  /** Names present in both places as real directories, or reserved by the caller; left untouched. */
  conflicts: string[];
  /** Client-owned entries also present in the client directory, moved out of the shared directory to `path`. */
  setAside: { name: string; path: string }[];
  /** True when a whole-directory link was replaced by per-skill links. */
  convertedDirectoryLink: boolean;
  /** A per-skill directory an interrupted conversion left next to a real directory; left untouched. */
  stranded: string[];
}

export interface SkillLinkIssue {
  name: string;
  issue: string;
  /**
   * `link`: ensureSkillLinks repairs it without moving skills. `unshared`: a client skill that
   * sync moves and declares. `conflict`: the user has to choose.
   */
  kind: "link" | "unshared" | "conflict";
}

export interface SkillLinkOptions {
  /**
   * Names dotagents already manages (declared in agents.toml or recorded in agents.lock). A client
   * directory with one of these names is never moved into the shared directory, and a shared entry
   * with a client-owned name such as `synced` is never moved out.
   */
  managedNames: ReadonlySet<string>;
  /**
   * Move skill directories the client created into the shared directory. Commands that do not
   * record the move in agents.toml, such as install, pass false and only link.
   */
  adopt?: boolean;
  /**
   * Names declared in agents.toml. A shared entry with a client-owned name stays in place while it
   * is declared: an earlier sync may have declared Claude Code's folder, and only sync removes that
   * declaration before the folder moves back.
   */
  declaredNames?: ReadonlySet<string>;
}

/** Names dotagents manages in a scope: declared skills other than wildcards, and lock entries. */
export function managedSkillNames(
  skills: readonly SkillDependency[],
  lockfile: Lockfile | null,
): Set<string> {
  return new Set([
    ...skills.filter((dep) => !isWildcardDep(dep)).map((dep) => dep.name),
    ...Object.keys(lockfile?.skills ?? {}),
  ]);
}

/** Names declared in agents.toml, other than wildcards. */
export function declaredSkillNames(skills: readonly SkillDependency[]): Set<string> {
  return new Set(skills.filter((dep) => !isWildcardDep(dep)).map((dep) => dep.name));
}

/**
 * Rename `from` to `to`. Entries are only renamed, like the directory migration in manager.ts, so
 * nothing is left half copied; across file systems this stops before anything moves.
 */
export async function moveEntry(from: string, to: string, renameEntry = rename): Promise<void> {
  try {
    await renameEntry(from, to);
  } catch (err) {
    if (!hasErrorCode(err, "EXDEV")) {throw err;}
    throw new SymlinkError(`${from} and ${to} are on different file systems, so dotagents cannot move it. Move it by hand, then run sync again.`);
  }
}

/**
 * Whether a shared entry with a client-owned name stays in the shared directory: a SKILL.md at its
 * top marks a user skill (Claude Code keeps skills one level deeper in synced/), and a declared
 * name waits for sync. A record in agents.lock alone does not keep it: a stale record would leave
 * Claude Code's folder in the shared directory, where sync prunes it.
 */
function isSkillWithReservedName(skillsSource: string, name: string, options: SkillLinkOptions): boolean {
  return existsSync(join(skillsSource, name, "SKILL.md")) || options.declaredNames?.has(name) === true;
}

/** Whether Claude Code reserves `name` in its skills directory. */
export function isClientOwnedName(name: string): boolean {
  return CLIENT_OWNED_ENTRIES.has(name);
}

/** Entries skipped when linking and sharing: client-owned ones and anything hidden. */
function isSkipped(name: string): boolean {
  return CLIENT_OWNED_ENTRIES.has(name) || name.startsWith(".");
}

/** Names of shared skills: directories with a valid skill name and a SKILL.md. */
async function sharedSkillNames(skillsSource: string): Promise<string[]> {
  if (!existsSync(skillsSource)) {return [];}
  const names: string[] = [];
  for (const entry of await readdir(skillsSource, { withFileTypes: true })) {
    if (isSkipped(entry.name) || entry.isFile()) {continue;}
    // Plugin skills are themselves links into .agents/plugins/, so follow links here.
    const path = managedSkillPath(skillsSource, entry.name);
    if (path && existsSync(join(path, "SKILL.md"))) {names.push(entry.name);}
  }
  return names.toSorted();
}

async function isSymlink(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink();
  } catch (err) {
    if (hasErrorCode(err, "ENOENT")) {return false;}
    throw err;
  }
}

/**
 * Whether `link` is the link dotagents creates for its skill: `<dir>/<name>` for a link named
 * `<name>`, compared as physical paths so home aliases match. Links to other entries belong to the user.
 */
async function isSkillLink(link: string, dir: string): Promise<boolean> {
  let target: string;
  try {
    target = resolve(await realpath(dirname(link)), await readlink(link));
  } catch (err) {
    // The client removed the entry after it was listed.
    if (hasErrorCode(err, "ENOENT")) {return false;}
    throw err;
  }
  if (basename(target) !== basename(link)) {return false;}
  let physicalDir: string;
  try {
    physicalDir = await realpath(dir);
  } catch {
    return false;
  }
  if (dirname(target) === physicalDir) {return true;}
  try {
    return (await realpath(dirname(target))) === physicalDir;
  } catch {
    return false;
  }
}

/**
 * Keep `<targetDir>/skills/` a real directory and link each shared skill into it as
 * `<targetDir>/skills/<name> -> <agentsDir>/skills/<name>`.
 *
 * - A whole-directory link to the shared directory (the earlier layout) is replaced; client-owned
 *   entries that ended up in the shared directory through it move back.
 * - Skill directories the client created in its own directory move into the shared directory and
 *   are replaced by links, unless the name is already shared or managed, or `adopt` is false.
 * - Links into the shared directory whose skill no longer exists are removed. Other entries are
 *   never touched.
 */
export async function ensureSkillLinks(
  agentsDir: string,
  targetDir: string,
  options: SkillLinkOptions,
): Promise<SkillLinksResult> {
  const skillsSource = join(agentsDir, "skills");
  const linkDir = join(targetDir, "skills");
  const result: SkillLinksResult = { linked: [], adopted: [], pruned: [], conflicts: [], setAside: [], convertedDirectoryLink: false, stranded: [] };

  await mkdir(skillsSource, { recursive: true });
  const physicalSource = await realpath(skillsSource);

  // Finish a conversion that stopped between removing the directory link and putting the new
  // directory in its place.
  const staging = join(targetDir, `.${basename(linkDir)}.dotagents-staging`);
  if (existsSync(staging)) {
    if (existsSync(linkDir) && !(await isSymlink(linkDir))) {
      result.stranded.push(staging);
    } else {
      if (await isSymlink(linkDir)) {
        await assertLinksToShared(linkDir, targetDir, skillsSource, physicalSource);
        await unlink(linkDir);
      }
      await rename(staging, linkDir);
      result.convertedDirectoryLink = true;
    }
  }

  let stat;
  try {
    stat = await lstat(linkDir);
  } catch (err) {
    if (!hasErrorCode(err, "ENOENT")) {throw err;}
  }
  if (stat?.isSymbolicLink()) {
    // Build the per-skill directory next to the link while the link still serves Claude Code,
    // then swap it in, so an interruption never leaves Claude Code without its skills.
    await assertLinksToShared(linkDir, targetDir, skillsSource, physicalSource);
    await mkdir(staging);
    const moves: [string, string][] = [];
    try {
      await linkSkills(agentsDir, skillsSource, staging, physicalSource, options, result, moves);
    } catch (err) {
      try {
        for (const [from, to] of moves.toReversed()) {await moveEntry(to, from);}
        await rm(staging, { recursive: true });
      } catch (cleanupErr) {
        const cause = err instanceof Error ? err.message : String(err);
        const cleanupCause = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
        throw new SymlinkError(
          `Converting ${linkDir} to per-skill links failed (${cause}), and ${staging} could not be emptied (${cleanupCause}). ${linkDir} still links the shared directory; move the entries in ${staging} back to ${skillsSource} by hand.`,
        );
      }
      throw err;
    }
    await unlink(linkDir);
    await rename(staging, linkDir);
    result.convertedDirectoryLink = true;
  } else if (stat && !stat.isDirectory()) {
    throw new SymlinkError(`${linkDir} exists but is not a directory or symlink`);
  }
  // After a conversion this runs again: Claude Code may have written synced/ through the old link
  // before the swap, and that copy is set aside here instead of staying shared.
  await mkdir(linkDir, { recursive: true });
  await linkSkills(agentsDir, skillsSource, linkDir, physicalSource, options, result, []);
  return result;
}

/** Throw unless `linkDir` links the shared directory, resolving it or, when it cannot be resolved, by its text. */
async function assertLinksToShared(linkDir: string, targetDir: string, skillsSource: string, physicalSource: string): Promise<void> {
  let resolved: string | undefined;
  try {
    resolved = await realpath(linkDir);
  } catch {
    const text = resolve(await realpath(targetDir), await readlink(linkDir));
    if (text !== physicalSource && text !== resolve(skillsSource)) {
      throw new SymlinkError(`${linkDir} is a link to ${text}, which cannot be resolved. Restore or move it before retrying.`);
    }
  }
  if (resolved !== undefined && resolved !== physicalSource) {
    throw new SymlinkError(`${linkDir} is a symlink to ${resolved}, not to ${skillsSource}. Move it away before retrying.`);
  }
}

async function linkSkills(
  agentsDir: string,
  skillsSource: string,
  linkDir: string,
  physicalSource: string,
  options: SkillLinkOptions,
  result: SkillLinksResult,
  moves: [string, string][],
): Promise<void> {
  // Client-owned entries found in the shared directory go back, also when an earlier run stopped
  // after removing the directory link.
  for (const name of CLIENT_OWNED_ENTRIES) {
    if (!existsSync(join(skillsSource, name))) {continue;}
    if (isSkillWithReservedName(skillsSource, name, options)) {
      result.conflicts.push(name);
      continue;
    }
    // A dangling link is the client's too; its target may only be unavailable for now.
    if (!existsSync(join(linkDir, name)) && !(await isSymlink(join(linkDir, name)))) {
      await moveEntry(join(skillsSource, name), join(linkDir, name));
      moves.push([join(skillsSource, name), join(linkDir, name)]);
      continue;
    }
    // The client already has its own copy; keep the stale one out of the shared directory.
    const backupDir = join(agentsDir, ".client-owned-backup");
    await mkdir(backupDir, { recursive: true });
    const backup = join(await mkdtemp(join(backupDir, `${name.replace(/^\./, "")}-`)), name);
    await moveEntry(join(skillsSource, name), backup);
    moves.push([join(skillsSource, name), backup]);
    result.setAside.push({ name, path: backup });
  }

  const shared = new Set(await sharedSkillNames(skillsSource));

  for (const entry of await readdir(linkDir, { withFileTypes: true })) {
    if (isSkipped(entry.name)) {continue;}
    const path = join(linkDir, entry.name);
    if (entry.isSymbolicLink()) {
      // A link into the shared directory whose entry is no longer a skill is stale.
      if (!shared.has(entry.name) && (await isSkillLink(path, skillsSource))) {
        await unlink(path);
        result.pruned.push(entry.name);
      }
      continue;
    }
    if (!entry.isDirectory()) {continue;}
    if (!managedSkillPath(linkDir, entry.name) || !existsSync(join(path, "SKILL.md"))) {continue;}
    if (existsSync(join(skillsSource, entry.name)) || options.managedNames.has(entry.name)) {
      result.conflicts.push(entry.name);
      continue;
    }
    if (options.adopt === false) {continue;}
    await moveEntry(path, join(skillsSource, entry.name));
    moves.push([path, join(skillsSource, entry.name)]);
    shared.add(entry.name);
    result.adopted.push(entry.name);
  }

  const physicalLinkDir = await realpath(linkDir);
  for (const name of [...shared].toSorted()) {
    const link = join(linkDir, name);
    const text = relative(physicalLinkDir, join(physicalSource, name));
    let existing;
    try {
      existing = await lstat(link);
    } catch (err) {
      if (!hasErrorCode(err, "ENOENT")) {throw err;}
    }
    if (existing?.isSymbolicLink()) {
      // Keep a link to this skill written in another form, such as an absolute path. A link that
      // points elsewhere belongs to the user, even while its target is missing.
      if (await readlink(link) !== text && !(await isSkillLink(link, skillsSource))) {
        result.conflicts.push(name);
      }
      continue;
    } else if (existing) {
      // A file or folder the client keeps under this name; the shared skill stays unlinked.
      if (!result.conflicts.includes(name)) {result.conflicts.push(name);}
      continue;
    }
    await symlink(text, link);
    result.linked.push(name);
  }
}

/** Report shared skills that are not linked into `<targetDir>/skills/` and stale links. */
export async function verifySkillLinks(
  agentsDir: string,
  targetDir: string,
  options: SkillLinkOptions,
): Promise<SkillLinkIssue[]> {
  const skillsSource = join(agentsDir, "skills");
  const linkDir = join(targetDir, "skills");
  const issues: SkillLinkIssue[] = [];

  let stat;
  try {
    stat = await lstat(linkDir);
  } catch {
    return [{ name: "skills", issue: `${linkDir} does not exist`, kind: "link" }];
  }
  if (stat.isSymbolicLink()) {
    const text = resolve(await realpath(targetDir), await readlink(linkDir));
    const sources = new Set([resolve(skillsSource)]);
    try {
      sources.add(await realpath(skillsSource));
    } catch {
      // The shared directory does not exist yet; compare the link text only.
    }
    let resolved = text;
    try {
      resolved = await realpath(linkDir);
    } catch {
      // A link that cannot be resolved is judged by its text, as ensureSkillLinks does.
    }
    if (!sources.has(resolved)) {
      return [{ name: "skills", issue: `${linkDir} links to ${text}, not to ${skillsSource}; move it away, then run sync`, kind: "conflict" }];
    }
    return [{ name: "skills", issue: `${linkDir} links the whole directory; per-skill links keep client-owned entries such as synced/ out of ${skillsSource}`, kind: "link" }];
  }

  const shared = new Set(await sharedSkillNames(skillsSource));
  for (const name of shared) {
    const link = join(linkDir, name);
    // A client skill folder under this name is reported once, with the entries below.
    if (!(await isSymlink(link)) && existsSync(join(link, "SKILL.md"))) {continue;}
    try {
      // Plugin skills are links themselves, so compare fully resolved paths on both sides.
      if ((await realpath(link)) !== (await realpath(join(skillsSource, name)))) {
        issues.push({ name, issue: `${link} does not point to ${join(skillsSource, name)}`, kind: "conflict" });
      }
    } catch {
      // ensureSkillLinks keeps a link that points elsewhere, even when its target is gone.
      const elsewhere = (await isSymlink(link)) && !(await isSkillLink(link, skillsSource));
      issues.push(elsewhere
        ? { name, issue: `${link} points to ${await readlink(link)}, which does not exist; replace it with a link to ${join(skillsSource, name)} or remove it`, kind: "conflict" }
        : { name, issue: `${link} is missing or broken`, kind: "link" });
    }
  }
  for (const entry of await readdir(linkDir, { withFileTypes: true })) {
    if (isSkipped(entry.name)) {continue;}
    const path = join(linkDir, entry.name);
    if (entry.isSymbolicLink() && !shared.has(entry.name) && (await isSkillLink(path, skillsSource))) {
      issues.push({ name: entry.name, issue: `${path} points to a skill that no longer exists`, kind: "link" });
    } else if (entry.isDirectory() && existsSync(join(path, "SKILL.md"))) {
      const installed = existsSync(join(skillsSource, entry.name));
      issues.push({
        name: entry.name,
        issue: installed
          ? `${path} and a skill named "${entry.name}" managed by dotagents both exist; keep one of them`
          : options.managedNames.has(entry.name)
            ? `${path} has the name of a skill declared in agents.toml or recorded in agents.lock but not installed; run install, or rename one of them`
            : `${path} is not shared yet`,
        kind: installed || options.managedNames.has(entry.name) ? "conflict" : "unshared",
      });
    }
  }
  for (const name of CLIENT_OWNED_ENTRIES) {
    if (existsSync(join(skillsSource, name))) {
      issues.push({
        name,
        issue: isSkillWithReservedName(skillsSource, name, options)
          ? `${join(skillsSource, name)} uses the name "${name}", which Claude Code reserves in ${linkDir}; if an earlier dotagents sync declared Claude Code's own folder under this name, run sync to remove that declaration, otherwise rename the skill`
          : `${join(skillsSource, name)} belongs in ${linkDir}`,
        kind: isSkillWithReservedName(skillsSource, name, options) ? "conflict" : "link",
      });
    }
  }
  return issues;
}

/** Remove `<targetDir>/skills/<name>` when it is a link into the shared directory. */
export async function unlinkSkill(agentsDir: string, targetDir: string, name: string): Promise<boolean> {
  const link = join(targetDir, "skills", name);
  try {
    if (!(await lstat(link)).isSymbolicLink()) {return false;}
  } catch (err) {
    if (hasErrorCode(err, "ENOENT")) {return false;}
    throw err;
  }
  if (!(await isSkillLink(link, join(agentsDir, "skills")))) {return false;}
  await unlink(link);
  return true;
}

/** Remove links into the shared directory whose entry is no longer a skill. */
export async function pruneSkillLinks(agentsDir: string, targetDir: string): Promise<string[]> {
  const skillsSource = join(agentsDir, "skills");
  const linkDir = join(targetDir, "skills");
  if (!existsSync(linkDir) || (await lstat(linkDir)).isSymbolicLink()) {return [];}
  const shared = new Set(await sharedSkillNames(skillsSource));
  const pruned: string[] = [];
  for (const entry of await readdir(linkDir, { withFileTypes: true })) {
    if (isSkipped(entry.name) || !entry.isSymbolicLink() || shared.has(entry.name)) {continue;}
    const path = join(linkDir, entry.name);
    if (!(await isSkillLink(path, skillsSource))) {continue;}
    await unlink(path);
    pruned.push(entry.name);
  }
  return pruned;
}
