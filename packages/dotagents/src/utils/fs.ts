import { resolve } from "node:path";
import { isInsideDir } from "@sentry/dotagents-lib";

const SKILL_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/** Whether a skill source points to its own install location (adopted orphan). */
export function isInPlaceSkill(source: string): boolean {
  return source.startsWith("path:.agents/skills/") || source.startsWith("path:skills/");
}

/** Resolve a managed skill directory, rejecting paths outside the skills root. */
export function managedSkillPath(skillsDir: string, name: string): string | null {
  if (!SKILL_NAME_RE.test(name)) {return null;}
  const root = resolve(skillsDir);
  const target = resolve(root, name);
  // The skills root itself is not a managed skill path — only entries beneath it.
  if (target === root || !isInsideDir(root, target)) {
    return null;
  }
  return target;
}
