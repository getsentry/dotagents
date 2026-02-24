import { z } from "zod/v4";

const lockedGitSkillSchema = z.object({
  source: z.string(),
  resolved_url: z.string(),
  resolved_path: z.string(),
  resolved_ref: z.string().optional(),
  commit: z.string().optional(),
  integrity: z.string().optional(),
});

const lockedLocalSkillSchema = z.object({
  source: z.string(),
  integrity: z.string().optional(),
});

const lockedSkillSchema = z.union([lockedGitSkillSchema, lockedLocalSkillSchema]);

export type LockedSkill = z.infer<typeof lockedSkillSchema>;

export const lockfileSchema = z.object({
  version: z.literal(1),
  skills: z.record(z.string(), lockedSkillSchema).default({}),
});

export type Lockfile = z.infer<typeof lockfileSchema>;

/**
 * Type guard: is this a git-based locked skill?
 */
export function isGitLocked(skill: LockedSkill): skill is z.infer<typeof lockedGitSkillSchema> {
  return "resolved_url" in skill;
}
