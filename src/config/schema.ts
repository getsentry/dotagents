import { z } from "zod/v4";

/**
 * Source specifier patterns (inferred from value):
 *   owner/repo          -- shorthand (resolved via defaultRepositorySource)
 *   owner/repo@ref      -- shorthand pinned
 *   https://gitlab.com/group/repo[.git][@ref] -- GitLab URL
 *   git@gitlab.com:group/repo[.git][@ref]     -- GitLab SSH URL
 *   git:https://...     -- non-GitHub git
 *   path:../relative    -- local filesystem
 */
const GIT_URL_VALID = /^git:(https:\/\/|git:\/\/|ssh:\/\/|git@|file:\/\/|\/)/;

/** GitHub HTTPS URL pattern — owner/repo must start with alphanumeric (no dash prefix). */
export const GITHUB_HTTPS_URL =
  /^https?:\/\/github\.com\/([a-zA-Z0-9][^/]*)\/([a-zA-Z0-9][^/@]*?)(?:\.git)?(?:\/)?(?:@(.+))?$/;
/** GitHub SSH URL pattern — owner/repo must start with alphanumeric (no dash prefix). */
export const GITHUB_SSH_URL =
  /^git@github\.com:([a-zA-Z0-9][^/]*)\/([a-zA-Z0-9][^/@]*?)(?:\.git)?(?:@(.+))?$/;
/** GitLab HTTPS URL pattern — supports nested groups/subgroups. */
export const GITLAB_HTTPS_URL =
  /^https?:\/\/gitlab\.com\/([a-zA-Z0-9][^@]*?)\/([a-zA-Z0-9][^/@]*?)(?:\.git)?(?:\/)?(?:@(.+))?$/;
/** GitLab SSH URL pattern — supports nested groups/subgroups. */
export const GITLAB_SSH_URL =
  /^git@gitlab\.com:([a-zA-Z0-9][^@]*?)\/([a-zA-Z0-9][^/@]*?)(?:\.git)?(?:@(.+))?$/;

const skillSourceSchema = z.string().check(
  z.refine((s) => {
    if (s.startsWith("git:")) {
      // Require a valid protocol scheme or absolute path to prevent argument injection
      return GIT_URL_VALID.test(s);
    }
    if (s.startsWith("path:")) {return true;}
    // GitHub HTTPS or SSH URLs
    if (GITHUB_HTTPS_URL.test(s)) {return true;}
    if (GITHUB_SSH_URL.test(s)) {return true;}
    // GitLab HTTPS or SSH URLs
    if (GITLAB_HTTPS_URL.test(s)) {return true;}
    if (GITLAB_SSH_URL.test(s)) {return true;}
    // Bare HTTPS URLs (well-known skill sources — HTTPS only to prevent MITM)
    // Require at least a hostname after the protocol (reject bare "https://")
    if (/^https:\/\/[^/]+/.test(s)) {return true;}
    // owner/repo or owner/repo@ref (strip npm-style leading @)
    const stripped = s.startsWith("@") ? s.slice(1) : s;
    const base = stripped.includes("@") ? stripped.slice(0, stripped.indexOf("@")) : stripped;
    const parts = base.split("/");
    return (
      parts.length === 2 &&
      parts.every((p) => p.length > 0 && !p.startsWith("-"))
    );
  }, "Must be owner/repo, owner/repo@ref, GitHub/GitLab URL, https://<domain> (well-known), git:<url> (with https/git/ssh protocol), or path:<relative>"),
);

export type SkillSource = z.infer<typeof skillSourceSchema>;

/** Skill names must be safe for use in file paths: alphanumeric, dots, hyphens, underscores. */
const skillNameSchema = z
  .string()
  .regex(
    /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/,
    "Skill names must start with alphanumeric and contain only [a-zA-Z0-9._-]",
  );

const wildcardSkillDependencySchema = z.object({
  name: z.literal("*"),
  source: skillSourceSchema,
  ref: z.string().optional(),
  exclude: z.array(skillNameSchema).default([]),
});

const regularSkillDependencySchema = z.object({
  name: skillNameSchema,
  source: skillSourceSchema,
  ref: z.string().optional(),
  path: z.string().optional(),
});

const skillDependencySchema = z.union([
  wildcardSkillDependencySchema,
  regularSkillDependencySchema,
]);

export type WildcardSkillDependency = z.infer<
  typeof wildcardSkillDependencySchema
>;
export type RegularSkillDependency = z.infer<
  typeof regularSkillDependencySchema
>;
export type SkillDependency = z.infer<typeof skillDependencySchema>;

export function isWildcardDep(
  dep: SkillDependency,
): dep is WildcardSkillDependency {
  return dep.name === "*";
}

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
    z.refine((m) => {
      const hasStdio = !!m.command;
      const hasHttp = !!m.url;
      return (hasStdio || hasHttp) && !(hasStdio && hasHttp);
    }, "MCP server must have either command (stdio) or url (http), but not both"),
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

const repositorySourceSchema = z.enum(["github", "gitlab"]);
export type RepositorySource = z.infer<typeof repositorySourceSchema>;

export const agentsConfigSchema = z.object({
  version: z.literal(1),
  defaultRepositorySource: repositorySourceSchema.default("github"),
  project: projectConfigSchema.optional(),
  symlinks: symlinksConfigSchema.optional(),
  agents: z.array(z.string()).default([]),
  skills: z.array(skillDependencySchema).default([]),
  mcp: z.array(mcpSchema).default([]),
  hooks: z.array(hookSchema).default([]),
  trust: trustConfigSchema.optional(),
  minimum_release_age: z.number().int().min(0).optional(),
  minimum_release_age_exclude: z.array(z.string()).default([]),
});

export type AgentsConfig = z.infer<typeof agentsConfigSchema>;
