import { z } from "zod/v4";

/**
 * Source specifier patterns (inferred from value):
 *   owner/repo          -- GitHub
 *   owner/repo@ref      -- GitHub pinned
 *   git:https://...     -- non-GitHub git
 *   path:../relative    -- local filesystem
 */
const GIT_URL_VALID = /^git:(https:\/\/|git:\/\/|ssh:\/\/|git@|file:\/\/|\/)/;

const skillSourceSchema = z.string().check(
  z.refine((s) => {
    if (s.startsWith("git:")) {
      // Require a valid protocol scheme or absolute path to prevent argument injection
      return GIT_URL_VALID.test(s);
    }
    if (s.startsWith("path:")) return true;
    // owner/repo or owner/repo@ref
    const base = s.includes("@") ? s.slice(0, s.indexOf("@")) : s;
    const parts = base.split("/");
    return parts.length === 2 && parts.every((p) => p.length > 0 && !p.startsWith("-"));
  }, "Must be owner/repo, owner/repo@ref, git:<url> (with https/git/ssh protocol), or path:<relative>"),
);

export type SkillSource = z.infer<typeof skillSourceSchema>;

/** Skill names must be safe for use in file paths: alphanumeric, dots, hyphens, underscores. */
const skillNameSchema = z.string().regex(
  /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/,
  "Skill names must start with alphanumeric and contain only [a-zA-Z0-9._-]",
);

const skillDependencySchema = z.object({
  name: skillNameSchema,
  source: skillSourceSchema,
  ref: z.string().optional(),
  path: z.string().optional(),
});

export type SkillDependency = z.infer<typeof skillDependencySchema>;

const symlinksConfigSchema = z.object({
  targets: z.array(z.string()).default([]),
});

export type SymlinksConfig = z.infer<typeof symlinksConfigSchema>;

const projectConfigSchema = z.object({
  name: z.string().optional(),
});

export type ProjectConfig = z.infer<typeof projectConfigSchema>;

/**
 * MCP server declaration: either stdio (command+args) or HTTP (url).
 * env is an array of environment variable names (values come from the user's env).
 */
const mcpSchema = z
  .object({
    name: z.string().min(1, "MCP server name is required"),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    url: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    env: z.array(z.string()).default([]),
  })
  .check(
    z.refine(
      (m) => {
        const hasStdio = !!m.command;
        const hasHttp = !!m.url;
        return (hasStdio || hasHttp) && !(hasStdio && hasHttp);
      },
      "MCP server must have either command (stdio) or url (http), but not both",
    ),
  );

export type McpConfig = z.infer<typeof mcpSchema>;

export const hookEventSchema = z.enum([
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "Stop",
]);

export type HookEvent = z.infer<typeof hookEventSchema>;

const hookSchema = z.object({
  event: hookEventSchema,
  matcher: z.string().optional(),
  command: z.string().min(1, "Hook command is required"),
});

export type HookConfig = z.infer<typeof hookSchema>;

const trustConfigSchema = z.object({
  allow_all: z.boolean().default(false),
  github_orgs: z.array(z.string()).default([]),
  github_repos: z.array(z.string()).default([]),
  git_domains: z.array(z.string()).default([]),
});

export type TrustConfig = z.infer<typeof trustConfigSchema>;

export const agentsConfigSchema = z.object({
  version: z.literal(1),
  gitignore: z.boolean().default(true),
  project: projectConfigSchema.optional(),
  symlinks: symlinksConfigSchema.optional(),
  agents: z.array(z.string()).default([]),
  skills: z.array(skillDependencySchema).default([]),
  mcp: z.array(mcpSchema).default([]),
  hooks: z.array(hookSchema).default([]),
  trust: trustConfigSchema.optional(),
});

export type AgentsConfig = z.infer<typeof agentsConfigSchema>;
