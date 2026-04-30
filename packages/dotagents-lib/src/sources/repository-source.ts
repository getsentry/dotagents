/**
 * Default repository host used when expanding `owner/repo` shorthand specifiers.
 */
export type RepositorySource = "github" | "gitlab";

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
