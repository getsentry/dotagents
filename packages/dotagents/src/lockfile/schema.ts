import { z } from "zod/v4";

const lockedGitSkillSchema = z.object({
  source: z.string(),
  resolved_url: z.string(),
  resolved_path: z.string(),
  resolved_ref: z.string().optional(),
  /** Informational only — records the commit installed. Not used for resolution. */
  resolved_commit: z.string().optional(),
});

const lockedWellKnownSkillSchema = z.object({
  source: z.string(),
  resolved_url: z.string(),
});

const lockedLocalSkillSchema = z.object({
  source: z.string(),
});

const lockedSkillSchema = z.union([lockedGitSkillSchema, lockedWellKnownSkillSchema, lockedLocalSkillSchema]);
const lockedLocalSubagentSchema = z.object({
  source: z.string(),
}).strict();
const lockedSubagentSchema = z.union([lockedGitSkillSchema, lockedLocalSubagentSchema]);
const lockedLocalPluginSchema = z.object({
  source: z.string(),
}).strict();
const lockedPluginSchema = z.union([lockedGitSkillSchema, lockedLocalPluginSchema]);

export type LockedSkill = z.infer<typeof lockedSkillSchema>;
export type LockedSubagent = z.infer<typeof lockedSubagentSchema>;
export type LockedPlugin = z.infer<typeof lockedPluginSchema>;

export const lockfileSchema = z.object({
  version: z.literal(1),
  skills: z.record(z.string(), lockedSkillSchema).default({}),
  subagents: z.record(z.string(), lockedSubagentSchema).default({}),
  plugins: z.record(z.string(), lockedPluginSchema).default({}),
});

export type Lockfile = z.infer<typeof lockfileSchema>;
