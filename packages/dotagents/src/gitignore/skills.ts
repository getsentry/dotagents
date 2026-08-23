import { lstat, readlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { isWildcardDep, type AgentsConfig } from "../config/schema.js";
import { isInPlaceSkill } from "../utils/fs.js";

/** Returns skill names declared as user-authored in-place `.agents/skills/` content. */
function declaredInPlaceSkillNames(config: AgentsConfig): Set<string> {
  return new Set(
    config.skills
      .filter((skill) => !isWildcardDep(skill) && isInPlaceSkill(skill.source))
      .map((skill) => skill.name),
  );
}

/** Keeps generated plugin skill projections from gitignoring user-authored skills. */
export async function filterManagedPluginSkillNames(
  skillNames: string[],
  config: AgentsConfig,
  skillsDir: string,
  pluginsDir: string,
): Promise<string[]> {
  const inPlaceNames = declaredInPlaceSkillNames(config);
  const managedNames: string[] = [];
  for (const name of skillNames) {
    if (inPlaceNames.has(name)) {continue;}
    if (await hasUnmanagedExistingSkill(skillsDir, pluginsDir, name)) {continue;}
    managedNames.push(name);
  }
  return managedNames;
}

async function hasUnmanagedExistingSkill(
  skillsDir: string,
  pluginsDir: string,
  name: string,
): Promise<boolean> {
  const skillPath = join(skillsDir, name);
  try {
    const stat = await lstat(skillPath);
    if (!stat.isSymbolicLink()) {return true;}
    const target = await readlink(skillPath);
    return !isInside(resolve(skillsDir, target), pluginsDir);
  } catch (err) {
    if (isNotFoundError(err)) {return false;}
    throw err;
  }
}

function isInside(path: string, root: string): boolean {
  const relPath = relative(resolve(root), resolve(path));
  return relPath === "" || (!relPath.startsWith("..") && !isAbsolute(relPath));
}

function isNotFoundError<ErrorValue>(err: ErrorValue): boolean {
  return err instanceof Error && "code" in err && err.code === "ENOENT";
}
