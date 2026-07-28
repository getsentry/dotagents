import { z } from "zod/v4";
import { posix, win32 } from "node:path";
import { parseSource } from "@sentry/dotagents-lib";

function sourceType(source: string): "git" | "local" | "well-known" | undefined {
  try {
    const type = parseSource(source).type;
    return type === "github" || type === "git" ? "git" : type;
  } catch {
    return undefined;
  }
}

const resolvedPathSchema = z.string().min(1).refine(
  (path) =>
    !posix.isAbsolute(path) &&
    !win32.isAbsolute(path) &&
    posix.normalize(path) === path &&
    path !== ".." &&
    !path.startsWith("../"),
  "resolved_path must be a normalized relative source path",
);

const lockedGitSkillSchema = z.object({
  source: z.string(),
  resolved_url: z.string(),
  resolved_path: z.string(),
  resolved_ref: z.string().optional(),
  /** Informational only — records the commit installed. Not used for resolution. */
  resolved_commit: z.string().optional(),
});

const lockedGitSkillEntrySchema = lockedGitSkillSchema.extend({
  resolved_path: resolvedPathSchema,
}).check(
  z.refine((skill) => sourceType(skill.source) === "git", "Git lock entry requires a Git source"),
);

const lockedWellKnownSkillSchema = z.object({
  source: z.string(),
  resolved_url: z.string(),
  resolved_path: z.never().optional(),
}).check(
  z.refine(
    (skill) => sourceType(skill.source) === "well-known",
    "Well-known lock entry requires a well-known source",
  ),
);

const lockedLocalSkillSchema = z.object({
  source: z.string(),
  resolved_url: z.never().optional(),
  resolved_path: resolvedPathSchema.optional(),
}).check(
  z.refine((skill) => sourceType(skill.source) === "local", "Local lock entry requires a local source"),
);

const lockedSkillSchema = z.union([
  lockedGitSkillEntrySchema,
  lockedWellKnownSkillSchema,
  lockedLocalSkillSchema,
]);
const lockedLocalSubagentSchema = z.object({
  source: z.string(),
}).strict();
const lockedSubagentSchema = z.union([lockedGitSkillSchema, lockedLocalSubagentSchema]);

export type LockedSkill = z.infer<typeof lockedSkillSchema>;
export type LockedSubagent = z.infer<typeof lockedSubagentSchema>;

export const lockfileSchema = z.object({
  version: z.literal(1),
  skills: z.record(z.string(), lockedSkillSchema).default({}),
  subagents: z.record(z.string(), lockedSubagentSchema).default({}),
});

export type Lockfile = z.infer<typeof lockfileSchema>;
