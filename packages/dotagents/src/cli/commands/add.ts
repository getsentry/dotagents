import { existsSync } from "node:fs";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import * as clack from "@clack/prompts";
import type { MultiSelectOptions, SelectOptions } from "@clack/prompts";
import chalk from "chalk";
import { loadConfig } from "../../config/loader.js";
import {
  isWildcardDep,
  GITHUB_HTTPS_URL,
  GITLAB_HTTPS_URL,
  PLUGIN_NAME_PATTERN,
  agentsConfigSchema,
} from "../../config/schema.js";
import {
  addPluginsToConfig,
  addSkillToConfig,
  addWildcardToConfig,
} from "../../config/writer.js";
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
  loadSkillMd,
  ensureCached,
  ensureWellKnownCached,
  sanitizeCacheKey,
  validateTrustedSource,
  TrustError,
  GitError,
  type CacheReuse,
} from "@sentry/dotagents-lib";
import { getCacheStateDir, HOST_SCAN_DIRS } from "../cache.js";
import { formatGitError, formatTrustError } from "../errors.js";
import { runInstall } from "./install.js";
import type { ScopeRoot } from "../../scope.js";
import { ensureUserScopeBootstrapped } from "../ensure-user-scope.js";
import { commandPrefix, type CommandContext } from "../context.js";
import {
  discoverPlugins,
  type PluginCandidate,
} from "../../plugins/store.js";
import { isNumber, isString } from "../../utils/type-guards.js";

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
  progress?: AddProgress;
  prompts?: AddPrompts;
}

type AddPromptValue = string | number;
type AddPromptResult = AddPromptValue | AddPromptValue[] | symbol;

export interface AddPrompts {
  select(options: SelectOptions<AddPromptValue>): Promise<AddPromptValue | symbol>;
  multiselect(options: MultiSelectOptions<AddPromptValue>): Promise<AddPromptValue[] | symbol>;
  isCancel(value: AddPromptResult): boolean;
  spinner: typeof clack.spinner;
}

const DEFAULT_ADD_PROMPTS: AddPrompts = {
  select: clack.select,
  multiselect: clack.multiselect,
  isCancel: clack.isCancel,
  spinner: clack.spinner,
};

export interface AddProgress {
  start(message: string): void;
  message(message: string): void;
  stop(message: string): void;
  error(message: string): void;
}

interface AcquiredSource {
  rootDir: string;
  pluginEligible: boolean;
  local: boolean;
  git: boolean;
  commit?: string;
}

type DuplicatePolicy = "single" | "specified" | "selected";

type SkillSelection =
  | { type: "wildcard" }
  | {
      type: "skills";
      names: string[];
      /** Exact duplicates refresh; specified names warn; prompted selections skip silently. */
      duplicatePolicy: DuplicatePolicy;
    };

interface PluginSelection {
  candidates: PluginCandidate[];
  duplicatePolicy: DuplicatePolicy;
}

interface DetailedAddResult {
  kind: "skill" | "plugin";
  result: string | string[];
  action: "added" | "refreshed";
}

function containsPath(parentDir: string, childDir: string): boolean {
  const childPath = relative(resolve(parentDir), resolve(childDir));
  return childPath === "" ||
    (childPath !== ".." && !childPath.startsWith(`..${sep}`) && !isAbsolute(childPath));
}

async function physicalPath(path: string): Promise<string> {
  let existingPath = resolve(path);
  const missingSegments: string[] = [];
  while (!existsSync(existingPath)) {
    const parentPath = dirname(existingPath);
    if (parentPath === existingPath) {return existingPath;}
    missingSegments.unshift(basename(existingPath));
    existingPath = parentPath;
  }
  return resolve(await realpath(existingPath), ...missingSegments);
}

async function acquireSource(
  parsed: ReturnType<typeof parseSource>,
  scope: ScopeRoot,
  effectiveRef: string | undefined,
): Promise<AcquiredSource> {
  if (parsed.type === "local") {
    const rootDir = await resolveLocalSource(scope.root, parsed.path!);
    return { rootDir, pluginEligible: true, local: true, git: false };
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
    return { rootDir: cached.cacheDir, pluginEligible: false, local: false, git: false };
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
  return {
    rootDir: cached.repoDir,
    pluginEligible: true,
    local: false,
    git: true,
    commit: cached.commit,
  };
}

async function verifyRequestedNames(
  rootDir: string,
  names: string[],
  source: string,
  command: string,
): Promise<void> {
  for (const name of names) {
    const found = await discoverSkill(rootDir, name, {
      scanDirs: HOST_SCAN_DIRS,
    });
    if (!found) {
      throw new AddError(
        `Skill "${name}" not found in ${source}. ` +
          `Use '${command} add ${source}' without --name to see available skills.`,
      );
    }
  }
}

async function selectSkills(
  acquired: AcquiredSource,
  names: string[] | undefined,
  source: string,
  interactive: boolean | undefined,
  command: string,
  prompts: AddPrompts,
): Promise<SkillSelection> {
  if (acquired.local && !names?.length) {
    const meta = await loadSkillMd(join(acquired.rootDir, "SKILL.md"));
    return {
      type: "skills",
      names: [meta.name],
      duplicatePolicy: "single",
    };
  }

  if (names?.length) {
    await verifyRequestedNames(acquired.rootDir, names, source, command);
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

  const mode = await prompts.select({
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
  if (prompts.isCancel(mode)) {throw new AddCancelledError();}
  if (mode === "all") {return { type: "wildcard" };}
  if (mode !== "pick") {throw new AddError("Invalid skill selection mode.");}

  const selected = await prompts.multiselect({
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
  if (prompts.isCancel(selected)) {throw new AddCancelledError();}
  if (!Array.isArray(selected)) {throw new AddError("Invalid skill selection.");}
  const selectedNames = selected.filter(isString);
  if (selectedNames.length !== selected.length) {throw new AddError("Invalid skill selection.");}
  return {
    type: "skills",
    names: selectedNames,
    duplicatePolicy: selectedNames.length === 1 ? "single" : "selected",
  };
}

function pluginCandidateForName(
  candidates: PluginCandidate[],
  name: string,
  source: string,
  command: string,
): PluginCandidate {
  const matches = candidates.filter((candidate) => candidate.name === name);
  if (matches.length === 0) {
    throw new AddError(
      `Plugin "${name}" not found in ${source}. ` +
        `Use '${command} add ${source}' without --name to see available plugins.`,
    );
  }
  if (matches.length > 1) {
    throw new AddError(
      `Plugin "${name}" is ambiguous in ${source}: ${matches.map((candidate) => candidate.path || ".").join(", ")}`,
    );
  }
  return matches[0]!;
}

function assertUniquePluginNames(
  candidates: PluginCandidate[],
  source: string,
): void {
  const byName = new Map<string, PluginCandidate[]>();
  for (const candidate of candidates) {
    const matches = byName.get(candidate.name) ?? [];
    matches.push(candidate);
    byName.set(candidate.name, matches);
  }
  for (const [name, matches] of byName) {
    if (matches.length > 1) {
      throw new AddError(
        `Plugin "${name}" is ambiguous in ${source}: ${matches.map((candidate) => candidate.path || ".").join(", ")}`,
      );
    }
  }
}

async function selectPlugins(
  candidates: PluginCandidate[],
  names: string[] | undefined,
  source: string,
  interactive: boolean | undefined,
  all: boolean | undefined,
  command: string,
  prompts: AddPrompts,
): Promise<PluginSelection> {
  if (all) {
    assertUniquePluginNames(candidates, source);
    return { candidates, duplicatePolicy: "specified" };
  }
  if (names?.length) {
    return {
      candidates: names.map((name) => pluginCandidateForName(candidates, name, source, command)),
      duplicatePolicy: names.length === 1 ? "single" : "specified",
    };
  }
  if (candidates.length === 1) {
    return { candidates, duplicatePolicy: "single" };
  }
  if (!interactive) {
    const availableNames = candidates.map((candidate) => candidate.name).toSorted();
    throw new AddError(
      `Multiple plugins found in ${source}: ${availableNames.join(", ")}. ` +
        "Specify plugin names as arguments, use --name to specify which ones, or --all for all plugins.",
    );
  }

  const mode = await prompts.select({
    message: `Multiple plugins found in ${source}. How would you like to add them?`,
    options: [
      {
        label: "All",
        value: "all" as const,
        hint: "Add every plugin currently discovered in this source",
      },
      {
        label: "Select specific plugins",
        value: "pick" as const,
        hint: "Choose individual plugins to add",
      },
    ],
  });
  if (prompts.isCancel(mode)) {throw new AddCancelledError();}
  if (mode === "all") {
    assertUniquePluginNames(candidates, source);
    return { candidates, duplicatePolicy: "selected" };
  }
  if (mode !== "pick") {throw new AddError("Invalid plugin selection mode.");}

  const pickerCandidates = candidates.toSorted((a, b) =>
    a.name.localeCompare(b.name) || a.path.localeCompare(b.path)
  );
  const selectedIndices = await prompts.multiselect({
    message: "Select which plugins to add:",
    options: pickerCandidates
      .map((candidate, index) => ({
        label: candidate.name,
        value: index,
        hint: candidate.path ? chalk.dim(`(${candidate.path})`) : "Source root",
      })),
    required: true,
  });
  if (prompts.isCancel(selectedIndices)) {throw new AddCancelledError();}
  if (!Array.isArray(selectedIndices)) {throw new AddError("Invalid plugin selection.");}
  const indices = selectedIndices.filter(isNumber);
  if (indices.length !== selectedIndices.length) {throw new AddError("Invalid plugin selection.");}
  const selected = indices.map((index) => {
    const candidate = pickerCandidates[index];
    if (!candidate) {throw new AddError("Invalid plugin selection.");}
    return candidate;
  });
  assertUniquePluginNames(selected, source);
  return {
    candidates: selected,
    duplicatePolicy: selected.length === 1 ? "single" : "selected",
  };
}

async function executeAdd(opts: AddOptions): Promise<DetailedAddResult> {
  const {
    scope,
    specifier: rawSpecifier,
    ref,
    names: rawNames,
    all,
    interactive,
    progress,
    prompts = DEFAULT_ADD_PROMPTS,
  } = opts;
  const command = commandPrefix(scope);
  const specifier = stripLeadingAt(rawSpecifier);
  const namesOverride = rawNames ? [...new Set(rawNames)] : rawNames;
  const { configPath } = scope;
  // Defer user bootstrap until classification so rejected plugins cannot mutate user state.
  const needsUserBootstrap = scope.scope === "user" && !existsSync(configPath);
  const config = needsUserBootstrap
    ? agentsConfigSchema.parse({ version: 1 })
    : await loadConfig(configPath);

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

  async function persistAndInstall(mutateConfig: () => Promise<void>): Promise<void> {
    if (needsUserBootstrap) {await ensureUserScopeBootstrapped(scope);}
    const previousConfig = await readFile(configPath, "utf-8");
    progress?.start("Installing components");
    try {
      await mutateConfig();
      if (reuse) {
        await runInstall({ scope, reuse });
      } else {
        await runInstall({ scope });
      }
      progress?.stop("Installation complete");
    } catch (err) {
      progress?.error("Installation failed");
      await writeFile(configPath, previousConfig, "utf-8");
      throw err;
    }
  }

  async function persistSkills(selection: SkillSelection): Promise<DetailedAddResult> {
    if (selection.type === "wildcard") {
      const existing = config.skills.find(
        (skill) =>
          isWildcardDep(skill) &&
          sourcesMatch(skill.source, sourceForStorage),
      );
      if (existing) {
        if (existing.ref !== effectiveRef) {
          throw new AddError(
            `A wildcard entry for "${sourceForStorage}" already exists in agents.toml with a different ref. Remove it first to re-add.`,
          );
        }
        await persistAndInstall(async () => {});
        return { kind: "skill", result: "*", action: "refreshed" };
      }
      await persistAndInstall(async () => {
        await addWildcardToConfig(configPath, sourceForStorage, {
          ...refOpts,
          exclude: [],
        });
      });
      return { kind: "skill", result: "*", action: "added" };
    }

    if (selection.duplicatePolicy === "single") {
      const name = selection.names[0]!;
      const existing = config.skills.find((skill) => skill.name === name);
      if (existing) {
        if (
          !sourcesMatch(existing.source, sourceForStorage) ||
          existing.ref !== effectiveRef
        ) {
          throw new AddError(
            `Skill "${name}" already exists in agents.toml with a different source or ref. Remove it first to re-add.`,
          );
        }
        await persistAndInstall(async () => {});
        return { kind: "skill", result: name, action: "refreshed" };
      }
      await persistAndInstall(async () => {
        await addSkillToConfig(configPath, name, {
          source: sourceForStorage,
          ...refOpts,
        });
      });
      return { kind: "skill", result: name, action: "added" };
    }

    const toAdd: string[] = [];
    const exactDuplicates: string[] = [];
    const conflictingDuplicates: string[] = [];
    for (const name of selection.names) {
      const existing = config.skills.find((skill) => skill.name === name);
      if (existing) {
        if (
          sourcesMatch(existing.source, sourceForStorage) &&
          existing.ref === effectiveRef
        ) {
          exactDuplicates.push(name);
        } else {
          conflictingDuplicates.push(name);
        }
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
      if (exactDuplicates.length === selection.names.length) {
        await persistAndInstall(async () => {});
        return { kind: "skill", result: exactDuplicates, action: "refreshed" };
      }
      throw new AddError(
        `Skills already exist in agents.toml with a different source or ref: ${conflictingDuplicates.join(", ")}.`,
      );
    }
    await persistAndInstall(async () => {
      for (const name of toAdd) {
        await addSkillToConfig(configPath, name, {
          source: sourceForStorage,
          ...refOpts,
        });
      }
    });
    return { kind: "skill", result: toAdd, action: "added" };
  }

  async function persistPlugins(selection: PluginSelection): Promise<DetailedAddResult> {
    const existingByName = new Map(
      config.plugins.map((plugin) => [plugin.name, plugin]),
    );
    if (selection.duplicatePolicy === "single") {
      const candidate = selection.candidates[0]!;
      const existing = existingByName.get(candidate.name);
      if (existing) {
        if (
          !sourcesMatch(existing.source, sourceForStorage) ||
          existing.ref !== effectiveRef ||
          (existing.path || ".") !== (candidate.path || ".")
        ) {
          throw new AddError(
            `Plugin "${candidate.name}" already exists in agents.toml with a different source, ref, or path. Remove it first to re-add.`,
          );
        }
        await persistAndInstall(async () => {});
        return { kind: "plugin", result: candidate.name, action: "refreshed" };
      }
      await persistAndInstall(async () => {
        await addPluginsToConfig(configPath, [{
          name: candidate.name,
          source: sourceForStorage,
          ...refOpts,
          // Pin every discovered directory so later source inventory changes cannot alter selection.
          path: candidate.path || ".",
        }]);
      });
      return { kind: "plugin", result: candidate.name, action: "added" };
    }

    const toAdd: PluginCandidate[] = [];
    const exactDuplicates: PluginCandidate[] = [];
    const conflictingDuplicates: PluginCandidate[] = [];
    for (const candidate of selection.candidates) {
      const existing = existingByName.get(candidate.name);
      if (existing) {
        if (
          sourcesMatch(existing.source, sourceForStorage) &&
          existing.ref === effectiveRef &&
          (existing.path || ".") === (candidate.path || ".")
        ) {
          exactDuplicates.push(candidate);
        } else {
          conflictingDuplicates.push(candidate);
        }
        if (selection.duplicatePolicy === "specified") {
          console.warn(
            chalk.yellow(`Skipping "${candidate.name}": already exists in agents.toml`),
          );
        }
        continue;
      }
      toAdd.push(candidate);
    }
    if (toAdd.length === 0) {
      if (exactDuplicates.length === selection.candidates.length) {
        await persistAndInstall(async () => {});
        return {
          kind: "plugin",
          result: exactDuplicates.map((candidate) => candidate.name),
          action: "refreshed",
        };
      }
      throw new AddError(
        `Plugins already exist in agents.toml with a different source, ref, or path: ${conflictingDuplicates.map((candidate) => candidate.name).join(", ")}.`,
      );
    }
    await persistAndInstall(async () => {
      await addPluginsToConfig(
        configPath,
        toAdd.map((candidate) => ({
          name: candidate.name,
          source: sourceForStorage,
          ...refOpts,
          path: candidate.path || ".",
        })),
      );
    });
    return {
      kind: "plugin",
      result: toAdd.map((candidate) => candidate.name),
      action: "added",
    };
  }

  progress?.start(`Resolving ${specifier}`);
  let acquired: AcquiredSource;
  let plugins: PluginCandidate[] = [];
  try {
    acquired = await acquireSource(parsed, scope, effectiveRef);
    progress?.message(`Inspecting ${specifier}`);
    if (acquired.pluginEligible) {
      plugins = await discoverPlugins(acquired.rootDir, namesOverride);
    }
    progress?.stop("Source ready");
  } catch (err) {
    progress?.error("Source resolution failed");
    const message = err instanceof Error ? err.message : String(err);
    throw err instanceof TrustError || err instanceof GitError
      ? err
      : new AddError(message);
  }
  let reuse: CacheReuse | undefined;
  if (acquired.git && acquired.commit) {
    reuse = { repoDir: acquired.rootDir, commit: acquired.commit };
    if (effectiveRef) {reuse.ref = effectiveRef;}
  }

  // Plugin presence classifies the entire source; bundled and standalone skills stay hidden.
  if (plugins.length > 0) {
    if (namesOverride?.length) {
      for (const name of namesOverride) {
        if (!PLUGIN_NAME_PATTERN.test(name)) {
          throw new AddError(
            `Invalid plugin name "${name}". Plugin names must be 1-64 lowercase letters, numbers, hyphens, or dots, have alphanumeric ends, and not contain '--' or '..'.`,
          );
        }
      }
    }
    const selection = await selectPlugins(
      plugins,
      namesOverride,
      sourceForStorage,
      interactive,
      all,
      command,
      prompts,
    );
    if (acquired.local) {
      const managedPluginsDir = await physicalPath(scope.pluginsDir);
      let enclosingCandidate: PluginCandidate | undefined;
      for (const candidate of selection.candidates) {
        const candidateDir = await realpath(candidate.dir);
        if (
          containsPath(candidateDir, managedPluginsDir) ||
          containsPath(managedPluginsDir, candidateDir)
        ) {
          enclosingCandidate = candidate;
          break;
        }
      }
      if (enclosingCandidate) {
        throw new AddError(
          `Plugin "${enclosingCandidate.name}" source overlaps this project's managed plugin directory. ` +
            "Use a plugin source elsewhere inside the project, outside .agents/plugins.",
        );
      }
    }
    return persistPlugins(selection);
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
  if (all) {return persistSkills({ type: "wildcard" });}
  const selection = await selectSkills(
    acquired,
    namesOverride,
    sourceForStorage,
    interactive,
    command,
    prompts,
  );
  return persistSkills(selection);
}

export async function runAdd(opts: AddOptions): Promise<string | string[]> {
  return (await executeAdd(opts)).result;
}

export default async function add(
  args: string[],
  context: CommandContext,
  prompts: AddPrompts = DEFAULT_ADD_PROMPTS,
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
        `Usage: ${commandPrefix(context.scope)} add <source> [<name>...] [--name <name>...] [--ref <ref>] [--all]`,
      ),
    );
    process.exitCode = 1;
    return;
  }

  const positionalNames = positionals.slice(1);
  const flagNames = [...(values["name"] ?? []), ...(values["skill"] ?? [])];

  if (positionalNames.length > 0 && flagNames.length > 0) {
    console.error(
      chalk.red(
        "Cannot mix positional names with --name/--skill flags. Use one or the other.",
      ),
    );
    process.exitCode = 1;
    return;
  }

  const rawNames = [...positionalNames, ...flagNames];
  const names = rawNames.length > 0 ? [...new Set(rawNames)] : undefined;

  try {
    const { scope } = context;
    const interactive =
      process.stdout.isTTY === true && !names && !values["all"];
    const progress = process.stdout.isTTY === true
      ? prompts.spinner({ indicator: "timer" })
      : undefined;
    const { kind, result, action } = await executeAdd({
      scope,
      specifier,
      ref: values["ref"],
      names,
      all: values["all"],
      interactive,
      progress,
      prompts,
    });
    if (action === "refreshed") {
      if (Array.isArray(result)) {
        console.log(
          chalk.green(
            `${kind === "skill" ? "Skills" : "Plugins"} already configured: ${result.join(", ")}. Refreshed installation.`,
          ),
        );
      } else if (kind === "skill" && result === "*") {
        console.log(
          chalk.green(
            `All skills from ${specifier} are already configured. Refreshed installation.`,
          ),
        );
      } else {
        console.log(
          chalk.green(
            `${kind === "skill" ? "Skill" : "Plugin"} "${result}" is already configured. Refreshed installation.`,
          ),
        );
      }
      return;
    }
    if (kind === "skill" && result === "*") {
      console.log(chalk.green(`Added all skills from ${specifier}`));
    } else if (Array.isArray(result)) {
      console.log(chalk.green(`Added ${kind}s: ${result.join(", ")}`));
    } else {
      console.log(chalk.green(`Added ${kind}: ${result}`));
    }
  } catch (err) {
    if (err instanceof AddCancelledError) {return;}
    if (err instanceof TrustError) {
      console.error(chalk.red(formatTrustError(err, context.scope)));
      process.exitCode = 1;
      return;
    }
    if (err instanceof GitError) {
      console.error(chalk.red(formatGitError(err, context.scope)));
      process.exitCode = 1;
      return;
    }
    if (err instanceof AddError) {
      console.error(chalk.red(err.message));
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}
