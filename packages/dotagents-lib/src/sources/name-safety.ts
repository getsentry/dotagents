/**
 * Reasons a git name field can fail safety validation.
 *
 *  - `leading-dash`: starts with `-` (would be parsed as a git flag).
 *  - `traversal`: equals `..`, `.`, or contains a `..` segment.
 *  - `invalid-characters`: outside the allow-list `[a-zA-Z0-9][a-zA-Z0-9._-]*`.
 */
export type GitNameSafetyReason =
  | "leading-dash"
  | "traversal"
  | "invalid-characters";

export type GitNameSafetyField = "owner" | "repo" | "ref";

export class GitNameSafetyError extends Error {
  readonly field: GitNameSafetyField;
  readonly reason: GitNameSafetyReason;

  constructor(field: GitNameSafetyField, reason: GitNameSafetyReason, message: string) {
    super(message);
    this.name = "GitNameSafetyError";
    this.field = field;
    this.reason = reason;
  }
}

/**
 * Owner / repo / ref segments must start with an alphanumeric and contain
 * only alphanumerics, dots, hyphens, and underscores. Matches GitHub's
 * username/repo character rules.
 */
const SAFE_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/**
 * Validate that owner/repo/ref values are safe to splice into a git command
 * and into filesystem paths. Throws `GitNameSafetyError` on the first violation.
 *
 * `parseSource` does not call this automatically — parse and validate stay
 * separable so callers that need the looser parse (e.g. `normalizeSource`
 * for dedup comparisons) aren't forced through the strict gate.
 *
 * `owner` is validated segment-by-segment so GitLab nested groups
 * (`group/subgroup`) pass when each segment is independently safe.
 */
export function validateGitNameSafety(input: {
  owner?: string;
  repo?: string;
  ref?: string;
}): void {
  if (input.owner !== undefined) {
    for (const segment of input.owner.split("/")) {
      validateSegment("owner", segment);
    }
  }
  if (input.repo !== undefined) {
    validateSegment("repo", input.repo);
  }
  if (input.ref !== undefined) {
    validateSegment("ref", input.ref);
  }
}

function validateSegment(field: GitNameSafetyField, value: string): void {
  if (value.startsWith("-")) {
    throw new GitNameSafetyError(
      field,
      "leading-dash",
      `${field} cannot start with '-' (would inject a git flag): ${JSON.stringify(value)}`,
    );
  }
  if (value === "." || value === "..") {
    throw new GitNameSafetyError(
      field,
      "traversal",
      `${field} cannot be a path-traversal segment: ${JSON.stringify(value)}`,
    );
  }
  if (!SAFE_NAME_PATTERN.test(value)) {
    throw new GitNameSafetyError(
      field,
      "invalid-characters",
      `${field} contains invalid characters: ${JSON.stringify(value)}`,
    );
  }
}
