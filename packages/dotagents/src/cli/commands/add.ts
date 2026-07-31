import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import * as clack from "@clack/prompts";
import chalk from "chalk";
import { loadConfig } from "../../config/loader.js";
import { isWildcardDep, GITHUB_HTTPS_URL, GITLAB_HTTPS_URL } from "../../config/schema.js";
import { addSkillToConfig, addWildcardToConfig } from "../../config/writer.js";
import {
  applyDefaultRepositorySource,
  isExplicitSourceSpecifier,
  parseOwnerRepoShorthand,
  parseSource,
  sourcesMatch,
  stripLeadingAt,
  VALID_SKILL_NAME,
  discoverAllSkills,
  discoverSkill,
  resolveLocalSource,
  resolveNpmSource,
  loadSkillMd,
  ensureCached,
  ensureWellKnownCached,
  sanitizeCacheKey,
  validateTrustedSource,
  TrustError,
  GitError,
} from "@sentry/dotagents-lib";
import { getCacheStateDir, HOST_SCAN_DIRS } from "../cache.js";
import { formatGitError, formatTrustError } from "../errors.js";
import { runInstall } from "./install.js";
import { resolveScope, resolveDefaultScope, ScopeError, type ScopeRoot } from "../../scope.js";
import { ensureUserScopeBootstrapped } from "../ensure-user-scope.js";

/** Parent paths that are standard/expected — no need to show them in the picker */
const STANDARD_PARENTS = new Set(["", "skills", ".agents/skills", ".claude/skills"]);

export class AddError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AddError";
  }
}

export class AddCancelledError extends Error {
  constructor() {
    super("Cancelled");
    this.name = "AddCancelledError";
  }
}

export interface AddOptions {
  scope: ScopeRoot;
  specifier: string;
  ref?: string;
  names?: string[];
  all?: boolean;
  interactive?: boolean;
}

type AcquiredSkills =
  | { type: "root-skill"; name: string }
  | { type: "catalog"; rootDir: string };

type AddSelection =
  | { type: "wildcard" }
  | {
      type: "skills";
      names: string[];
      /** Single names reject duplicates; specified names warn; prompted selections skip silently. */
      duplicatePolicy: "single" | "specified" | "selected";
    };

async function acquireSkills(
  parsed: ReturnType<typeof parseSource>,
  scope: ScopeRoot,
  effectiveRef: string | undefined,
  hasExplicitNames: boolean,
): Promise<AcquiredSkills> {
  if (parsed.type === "local") {
    const rootDir = await resolveLocalSource(scope.root, parsed.path!);
    if (hasExplicitNames) {return { type: "catalog", rootDir };}
    const meta = await loadSkillMd(join(rootDir, "SKILL.md"));
    return { type: "root-skill", name: meta.name };
  }

  if (parsed.type === "npm") {
    const rootDir = await resolveNpmSource(scope.root, parsed.path!);
    if (hasExplicitNames) {return { type: "catalog", rootDir };}
    const meta = await loadSkillMd(join(rootDir, "SKILL.md"));
    return { type: "root-skill", name: meta.name };
  }

  if (parsed.type === "well-known") {
    const baseUrl = parsed.url!;
    const url = new URL(baseUrl);
    const pathname = url.pathname.endsWith("/")
      ? url.pathname.slice(0, -1)
      : url.pathname;
    const cached = await ensureWellKnownCached({
      stateDir: getCacheStateDir(),
      url: baseUrl,
      cacheKey: `wellknown/${url.host.toLowerCase()}${pathname}`,
    });
    if (!cached) {
      throw new AddError(
        `No skills found at ${baseUrl}. If this is a git repository, use the git: prefix: git:${baseUrl}`,
      );
    }
    return { type: "catalog", rootDir: cached.cacheDir };
  }

  const url = parsed.url!;
  const cached = await ensureCached({
    stateDir: getCacheStateDir(),
    url: parsed.cloneUrl ?? url,
    cacheKey: parsed.type === "github"
      ? `${parsed.owner}/${parsed.repo}`
      : sanitizeCacheKey(url),
    ref: effectiveRef,
  });
  return { type: "catalog", rootDir: cached.repoDir };
}

async function verifyRequestedNames(
  rootDir: string,
  names: string[],
  source: string,
): Promise<void> {
  for (const name of names) {
    const found = await discoverSkill(rootDir, name, {
      scanDirs: HOST_SCAN_DIRS,
    });
    if (!found) {
      throw new AddError(
        `Skill "${name}" not found in ${source}. ` +
          `Use 'npx @sentry/dotagents add ${source}' without --name to see available skills.`,
      );
    }
  }
}

async function selectSkills(
  acquired: AcquiredSkills,
  names: string[] | undefined,
  source: string,
  interactive: boolean | undefined,
): Promise<AddSelection> {
  if (acquired.type === "root-skill") {
    return {
      type: "skills",
      names: [acquired.name],
      duplicatePolicy: "single",
    };
  }

  if (names?.length) {
    await verifyRequestedNames(acquired.rootDir, names, source);
    return {
      type: "skills",
      names,
      duplicatePolicy: names.length === 1 ? "single" : "specified",
    };
  }

  const skills = await discoverAllSkills(acquired.rootDir, {
    scanDirs: HOST_SCAN_DIRS,
  });
  if (skills.length === 0) {
    throw new AddError(`No skills found in ${source}.`);
  }
  if (skills.length === 1) {
    return {
      type: "skills",
      names: [skills[0]!.meta.name],
      duplicatePolicy: "single",
    };
  }
  if (!interactive) {
    const availableNames = skills.map((skill) => skill.meta.name).toSorted();
    throw new AddError(
      `Multiple skills found in ${source}: ${availableNames.join(", ")}. ` +
        "Specify skill names as arguments, use --skill to specify which ones, or --all for all skills.",
    );
  }

  const mode = await clack.select({
    message: `Multiple skills found in ${source}. How would you like to add them?`,
    options: [
      {
        label: "All",
        value: "all" as const,
        hint: "Wildcard entry — automatically includes new skills added upstream",
      },
      {
        label: "Select specific skills",
        value: "pick" as const,
        hint: "Choose individual skills to add",
      },
    ],
  });
  if (clack.isCancel(mode)) {throw new AddCancelledError();}
  if (mode === "all") {return { type: "wildcard" };}

  const selected = await clack.multiselect({
    message: "Select which skills to add:",
    options: skills
      .toSorted((a, b) => a.meta.name.localeCompare(b.meta.name))
      .map((skill) => {
        const lastSlash = skill.path.lastIndexOf("/");
        const parentPath = lastSlash === -1
          ? ""
          : skill.path.slice(0, lastSlash);
        const pathHint = STANDARD_PARENTS.has(parentPath)
          ? ""
          : chalk.dim(`(${skill.path}) `);
        return {
          label: skill.meta.name,
          value: skill.meta.name,
          hint: pathHint + skill.meta.description,
        };
      }),
    required: true,
  });
  if (clack.isCancel(selected)) {throw new AddCancelledError();}
  return {
    type: "skills",
    names: selected,
    duplicatePolicy: selected.length === 1 ? "single" : "selected",
  };
}

export async function runAdd(opts: AddOptions): Promise<string | string[]> {
  const {
    scope,
    specifier: rawSpecifier,
    ref,
    names: rawNames,
    all,
    interactive,
  } = opts;
  const specifier = stripLeadingAt(rawSpecifier);
  const namesOverride = rawNames ? [...new Set(rawNames)] : rawNames;
  const { configPath } = scope;
  const config = await loadConfig(configPath);

  const hintedSpecifier = applyDefaultRepositorySource(
    specifier,
    config.defaultRepositorySource,
  );

  if (!isExplicitSourceSpecifier(hintedSpecifier) && !parseOwnerRepoShorthand(hintedSpecifier)) {
    throw new AddError(
      `Invalid source "${specifier}". ` +
        `Use owner/repo shorthand, an explicit URL, git:<url>, or path:<relative>.`,
    );
  }

  if (/^http:\/\//i.test(hintedSpecifier) && !GITHUB_HTTPS_URL.test(hintedSpecifier) && !GITLAB_HTTPS_URL.test(hintedSpecifier)) {
    throw new AddError(
      `Insecure source "${specifier}". Well-known sources require HTTPS. ` +
        `Use https:// or the git: prefix for git repos.`,
    );
  }

  const parsed = parseSource(hintedSpecifier);

  const sourceForStorage = parsed.ref
    ? specifier.slice(0, -(parsed.ref.length + 1))
    : specifier;
  validateTrustedSource(hintedSpecifier, config.trust);
  const effectiveRef = ref ?? parsed.ref;
  const refOpts = effectiveRef ? { ref: effectiveRef } : {};

  if (all && namesOverride?.length) {
    throw new AddError("Cannot use --all with --name. Use one or the other.");
  }

  if (namesOverride?.length) {
    for (const name of namesOverride) {
      if (!VALID_SKILL_NAME.test(name)) {
        throw new AddError(
          `Invalid skill name "${name}". Names must start with alphanumeric and contain only alphanumeric, dots, underscores, or hyphens.`,
        );
      }
    }
  }

  async function persist(selection: AddSelection): Promise<string | string[]> {
    if (selection.type === "wildcard") {
      if (
        config.skills.some(
          (skill) =>
            isWildcardDep(skill) &&
            sourcesMatch(skill.source, sourceForStorage),
        )
      ) {
        throw new AddError(
          `A wildcard entry for "${sourceForStorage}" already exists in agents.toml.`,
        );
      }
      await addWildcardToConfig(configPath, sourceForStorage, {
        ...refOpts,
        exclude: [],
      });
      await runInstall({ scope });
      return "*";
    }

    if (selection.duplicatePolicy === "single") {
      const name = selection.names[0]!;
      if (config.skills.some((skill) => skill.name === name)) {
        throw new AddError(
          `Skill "${name}" already exists in agents.toml. Remove it first to re-add.`,
        );
      }
      await addSkillToConfig(configPath, name, {
        source: sourceForStorage,
        ...refOpts,
      });
      await runInstall({ scope });
      return name;
    }

    const toAdd: string[] = [];
    for (const name of selection.names) {
      if (config.skills.some((skill) => skill.name === name)) {
        if (selection.duplicatePolicy === "specified") {
          console.warn(
            chalk.yellow(`Skipping "${name}": already exists in agents.toml`),
          );
        }
        continue;
      }
      toAdd.push(name);
    }
    if (toAdd.length === 0) {
      const qualifier = selection.duplicatePolicy === "selected"
        ? "selected"
        : "specified";
      throw new AddError(
        `All ${qualifier} skills already exist in agents.toml.`,
      );
    }
    for (const name of toAdd) {
      await addSkillToConfig(configPath, name, {
        source: sourceForStorage,
        ...refOpts,
      });
    }
    await runInstall({ scope });
    return toAdd;
  }

  if (all) {
    return persist({ type: "wildcard" });
  }

  const acquired = await acquireSkills(
    parsed,
    scope,
    effectiveRef,
    !!namesOverride?.length,
  );
  const selection = await selectSkills(
    acquired,
    namesOverride,
    sourceForStorage,
    interactive,
  );
  return persist(selection);
}

export default async function add(
  args: string[],
  flags?: { user?: boolean },
): Promise<void> {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      ref: { type: "string" },
      name: { type: "string", multiple: true },
      skill: { type: "string", multiple: true },
      all: { type: "boolean" },
    },
    strict: true,
  });

  const specifier = positionals[0];
  if (!specifier) {
    console.error(
      chalk.red(
        "Usage: npx @sentry/dotagents add <specifier> [<skill>...] [--skill <name>...] [--ref <ref>] [--all]",
      ),
    );
    process.exitCode = 1;
    return;
  }

  // Collect skill names from positional args and flags
  const positionalNames = positionals.slice(1);
  const flagNames = [...(values["name"] ?? []), ...(values["skill"] ?? [])];

  if (positionalNames.length > 0 && flagNames.length > 0) {
    console.error(
      chalk.red(
        "Cannot mix positional skill names with --skill/--name flags. Use one or the other.",
      ),
    );
    process.exitCode = 1;
    return;
  }

  const rawNames = [...positionalNames, ...flagNames];
  const names = rawNames.length > 0 ? [...new Set(rawNames)] : undefined;

  try {
    const scope = flags?.user
      ? resolveScope("user")
      : resolveDefaultScope(resolve("."));
    await ensureUserScopeBootstrapped(scope);
    const interactive =
      process.stdout.isTTY === true && !names && !values["all"];
    const result = await runAdd({
      scope,
      specifier,
      ref: values["ref"],
      names,
      all: values["all"],
      interactive,
    });
    if (result === "*") {
      console.log(chalk.green(`Added all skills from ${specifier}`));
    } else if (Array.isArray(result)) {
      console.log(chalk.green(`Added skills: ${result.join(", ")}`));
    } else {
      console.log(chalk.green(`Added skill: ${result}`));
    }
  } catch (err) {
    if (err instanceof AddCancelledError) {return;}
    if (err instanceof TrustError) {
      console.error(chalk.red(formatTrustError(err)));
      process.exitCode = 1;
      return;
    }
    if (err instanceof GitError) {
      console.error(chalk.red(formatGitError(err)));
      process.exitCode = 1;
      return;
    }
    if (err instanceof ScopeError || err instanceof AddError) {
      console.error(chalk.red(err.message));
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}
