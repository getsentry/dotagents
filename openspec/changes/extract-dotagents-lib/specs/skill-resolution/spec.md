## ADDED Requirements

### Requirement: Source specifier parsing

The library SHALL parse skill source specifiers into a typed `ParsedSource` value covering the following grammars:

- `path:<relative-or-absolute-path>` — local source.
- `git:<url>` — explicit generic git source.
- `https://github.com/<owner>/<repo>[@<ref>]` and `git@github.com:<owner>/<repo>.git[@<ref>]` — GitHub source.
- `https://gitlab.com/<owner>/<repo>[@<ref>]` and `git@gitlab.com:<owner>/<repo>.git[@<ref>]` — GitLab source.
- Bare `https://<host>/<path>` not matching the GitHub/GitLab patterns — well-known HTTP source.
- `<owner>/<repo>[@<ref>]` and `@<owner>/<repo>[@<ref>]` — owner/repo shorthand, expanded against a configurable default repository host.

The library SHALL reject `http://` (non-TLS) sources for well-known parsing to prevent man-in-the-middle attacks.

The library SHALL expose `parseSource`, `isExplicitSourceSpecifier`, `parseOwnerRepoShorthand`, `applyDefaultRepositorySource`, `normalizeSource`, and `sourcesMatch` as part of its public API.

#### Scenario: Explicit local source
- **WHEN** `parseSource("path:./skills/foo")` is called
- **THEN** the result has `type: "local"` and `path: "./skills/foo"`

#### Scenario: Owner/repo shorthand expanded with GitHub default
- **WHEN** `applyDefaultRepositorySource("anthropics/skills@v1", "github")` is called
- **THEN** the result is `"https://github.com/anthropics/skills@v1"`

#### Scenario: Owner/repo shorthand expanded with GitLab default
- **WHEN** `applyDefaultRepositorySource("group/repo", "gitlab")` is called
- **THEN** the result is `"https://gitlab.com/group/repo"`

#### Scenario: GitLab nested groups under GitLab default
- **WHEN** `applyDefaultRepositorySource("group/sub/repo@v2", "gitlab")` is called
- **THEN** the result is `"https://gitlab.com/group/sub/repo@v2"`

#### Scenario: HTTPS GitHub URL parses to github type
- **WHEN** `parseSource("https://github.com/anthropics/skills@main")` is called
- **THEN** the result has `type: "github"`, `owner: "anthropics"`, `repo: "skills"`, `ref: "main"`, and a `cloneUrl` without the `@ref` suffix

#### Scenario: Bare HTTPS URL parses as well-known
- **WHEN** `parseSource("https://cli.sentry.dev/skills")` is called
- **THEN** the result has `type: "well-known"` and `url: "https://cli.sentry.dev/skills"`

#### Scenario: HTTP URL is rejected as well-known
- **WHEN** `parseSource("http://example.com/skills")` is called
- **THEN** the result is NOT `type: "well-known"`

### Requirement: SKILL.md loading

The library SHALL parse SKILL.md files and extract YAML frontmatter into a `SkillMeta` object containing at minimum `name` (string) and `description` (string), preserving any additional frontmatter keys.

The library SHALL throw `SkillLoadError` when the file cannot be read, when no YAML frontmatter delimiters are present, or when required fields are missing or empty.

#### Scenario: Valid SKILL.md is parsed
- **WHEN** `loadSkillMd` is called with a path to a SKILL.md containing valid frontmatter with `name` and `description`
- **THEN** it returns a `SkillMeta` with those fields populated

#### Scenario: Missing frontmatter raises SkillLoadError
- **WHEN** `loadSkillMd` is called with a file lacking `---` delimiters
- **THEN** it throws `SkillLoadError`

#### Scenario: Missing required field raises SkillLoadError
- **WHEN** `loadSkillMd` is called with frontmatter missing `description`
- **THEN** it throws `SkillLoadError`

### Requirement: Skill discovery within a directory

The library SHALL discover SKILL.md files within a directory tree, returning their relative paths and parsed metadata. It SHALL expose:

- `discoverSkill(rootDir, skillName)` — locate a single named skill in conventional layouts.
- `discoverAllSkills(rootDir)` — enumerate every discoverable skill in a directory.

The library SHALL validate skill names against `^[a-zA-Z0-9][a-zA-Z0-9._-]*$` when enumerating wildcard sources to prevent path-traversal-prone names from being returned.

#### Scenario: Single named skill is found
- **WHEN** `discoverSkill("/cache/anthropics/skills", "code-review")` is called
- **THEN** it returns a `DiscoveredSkill` with the relative `path` to the directory containing that skill's SKILL.md

#### Scenario: Wildcard discovery filters unsafe names
- **WHEN** `discoverAllSkills` returns a skill whose name fails the `VALID_SKILL_NAME` pattern
- **THEN** wildcard resolution callers MUST exclude it from the returned list

### Requirement: Skill resolution to a directory on disk

The library SHALL resolve a skill dependency to a concrete on-disk directory. It SHALL expose `resolveSkill(skillName, dep, opts?)` returning a `ResolvedSkill` discriminated union with `type: "git" | "local" | "well-known"`.

For `local` dependencies the library SHALL resolve the path against the caller-supplied `projectRoot` (or `process.cwd()` when omitted).

For git dependencies the library SHALL ensure the source is cached locally (cloning if absent, fetching if present), select the requested ref, and return the absolute path to the skill subdirectory inside the cache, along with the resolved 40-character commit SHA.

For well-known HTTP dependencies the library SHALL fetch the source into the cache and return the path to the discovered skill subdirectory; when the source returns no skills, it SHALL throw `ResolveError` with guidance to use `git:` for git sources.

The library SHALL throw `ResolveError` when the named skill cannot be discovered in the resolved source.

#### Scenario: Local resolution returns absolute directory
- **WHEN** `resolveSkill("foo", { source: "path:./skills/foo" }, { projectRoot: "/work/proj" })` is called
- **THEN** it returns `{ type: "local", source: "path:./skills/foo", skillDir: "/work/proj/skills/foo" }`

#### Scenario: Git resolution returns commit SHA
- **WHEN** `resolveSkill("code-review", { source: "anthropics/skills", ref: "v1.2.3" })` is called
- **THEN** it returns a `ResolvedSkill` with `type: "git"`, a populated `commit` field (40 hex chars), and `skillDir` pointing inside the cache

#### Scenario: Skill not found in source raises ResolveError
- **WHEN** `resolveSkill("does-not-exist", { source: "anthropics/skills" })` is called and no SKILL.md matches the name
- **THEN** it throws `ResolveError`

### Requirement: Wildcard skill resolution

The library SHALL expose `resolveWildcardSkills(dep, opts?)` to resolve every skill from a source. It SHALL accept an `exclude` list of skill names to omit, and SHALL drop skills whose `name` violates `VALID_SKILL_NAME`.

#### Scenario: Excludes are honored
- **WHEN** `resolveWildcardSkills({ source: "anthropics/skills", exclude: ["legacy-skill"] })` is called and the source contains `legacy-skill`
- **THEN** the returned list does NOT contain an entry for `legacy-skill`

### Requirement: Configurable cache location

The library SHALL maintain a global content cache for git and well-known sources. It SHALL expose `configureCache({ stateDir })` to set the cache root, and SHALL also honor a `DOTAGENTS_STATE_DIR` environment variable for back-compat with existing dotagents installations.

When neither is set, the library SHALL default to `~/.local/dotagents/`.

The cache SHALL fetch from the remote on every `ensureCached` call when a clone already exists (no TTL), so callers always observe the latest commit reachable from the requested ref.

The library SHALL expose `ensureCached`, `ensureWellKnownCached`, and `resolveLocalSource` as low-level cache primitives for callers that share the cache across operations.

#### Scenario: Caller overrides cache directory
- **WHEN** a caller invokes `configureCache({ stateDir: "/tmp/my-cache" })` and then resolves a git skill
- **THEN** the cached clone is created under `/tmp/my-cache/<owner>/<repo>/` and not under `~/.local/dotagents/`

#### Scenario: DOTAGENTS_STATE_DIR is honored
- **WHEN** `DOTAGENTS_STATE_DIR=/var/cache/dotagents` is set and `configureCache` has not been called
- **THEN** caches are written under `/var/cache/dotagents/`

#### Scenario: Default cache location
- **WHEN** neither `configureCache` has been called nor `DOTAGENTS_STATE_DIR` is set
- **THEN** caches are written under `~/.local/dotagents/`

### Requirement: Minimum release age gate

The library SHALL accept a `minimumReleaseAge` option (in minutes) on `resolveSkill` and `resolveWildcardSkills`. When set, it SHALL resolve to the newest commit at least that many minutes old.

The library SHALL accept a `minimumReleaseAgeExclude` list of `org` or `org/repo` patterns; sources matching the list SHALL be exempt from the age gate.

#### Scenario: Age gate skips fresh commits
- **WHEN** the resolver is called with `minimumReleaseAge: 60` against a source whose HEAD is 10 minutes old
- **THEN** the resolver picks an older commit at least 60 minutes old, or fails if none exists

#### Scenario: Excluded source bypasses age gate
- **WHEN** the resolver is called with `minimumReleaseAge: 60` and `minimumReleaseAgeExclude: ["my-org"]` against `my-org/repo`
- **THEN** the latest commit is used regardless of age

### Requirement: Optional trust enforcement at resolution time

The library SHALL define a structural `TrustPolicy` interface that callers (including the host package) can satisfy.

`resolveSkill` and `resolveWildcardSkills` SHALL accept an optional `trust?: TrustPolicy` parameter. When provided, the resolver SHALL validate the source against the policy before any network access (clone, fetch, or HTTP get). If validation fails the resolver SHALL throw `TrustError`.

When `trust` is omitted the resolver SHALL NOT enforce trust — preserving today's behavior where the host CLI calls `validateTrustedSource` separately during install/sync.

#### Scenario: Trust enforced at resolver and source is allowed
- **WHEN** `resolveSkill("foo", { source: "anthropics/skills" }, { trust: policy })` is called and `policy` permits `anthropics/skills`
- **THEN** resolution proceeds normally

#### Scenario: Trust enforced at resolver and source is denied
- **WHEN** `resolveSkill("foo", { source: "evil/skills" }, { trust: policy })` is called and `policy` rejects `evil/skills`
- **THEN** the resolver throws `TrustError` and performs no network access

#### Scenario: Trust opt omitted — no enforcement
- **WHEN** `resolveSkill` is called without a `trust` option
- **THEN** the resolver does NOT call trust validation, matching today's behavior

### Requirement: Trust validation primitive

The library SHALL expose `validateTrustedSource(source, policy)` and `extractDomain(source)` for callers (including hosts that perform pre-resolution gating). The library SHALL throw `TrustError` when validation fails.

#### Scenario: Allowed source passes validation
- **WHEN** `validateTrustedSource("anthropics/skills", policy)` is called and the policy lists `anthropics` or `anthropics/skills`
- **THEN** the call returns without throwing

#### Scenario: Disallowed source throws TrustError
- **WHEN** `validateTrustedSource("evil/skills", policy)` is called and the policy does not list it
- **THEN** the call throws `TrustError`

### Requirement: Repository source type ownership

The library SHALL define and export the `RepositorySource` union (`"github" | "gitlab"`). The host's `agents.toml` schema SHALL import this type from the library rather than defining its own.

#### Scenario: Library is single source of truth
- **WHEN** the host's config schema needs the `RepositorySource` type
- **THEN** it imports it from `dotagents-lib`
