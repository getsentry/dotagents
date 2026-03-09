import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import * as clack from "@clack/prompts";
import chalk from "chalk";
import { loadConfig } from "../../config/loader.js";
import { isWildcardDep } from "../../config/schema.js";
import { addSkillToConfig, addWildcardToConfig } from "../../config/writer.js";
import {
  applyDefaultRepositorySource,
  isExplicitSourceSpecifier,
  parseOwnerRepoShorthand,
  parseSource,
  sourcesMatch,
  VALID_SKILL_NAME,
} from "../../skills/resolver.js";
import { discoverAllSkills, discoverSkill } from "../../skills/discovery.js";
import { resolveLocalSource } from "../../sources/local.js";
import { loadSkillMd } from "../../skills/loader.js";
import { ensureCached } from "../../sources/cache.js";
import { validateTrustedSource, TrustError } from "../../trust/index.js";
import { runInstall } from "./install.js";
import { resolveScope, resolveDefaultScope, ScopeError, type ScopeRoot } from "../../scope.js";

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

export async function runAdd(opts: AddOptions): Promise<string | string[]> {
  const {
    scope,
    specifier,
    ref,
    names: rawNames,
    all,
    interactive,
  } = opts;
  // Deduplicate names to prevent writing duplicate config entries
  const namesOverride = rawNames ? [...new Set(rawNames)] : rawNames;
  const { configPath } = scope;

  // Load config early so we can check trust before any network work
  const config = await loadConfig(configPath);

  // Validate the specifier is a recognized source format
  if (!isExplicitSourceSpecifier(specifier) && !parseOwnerRepoShorthand(specifier)) {
    throw new AddError(
      `Invalid source "${specifier}". ` +
        `Use owner/repo shorthand, an explicit URL, git:<url>, or path:<relative>.`,
    );
  }

  const hintedSpecifier = applyDefaultRepositorySource(
    specifier,
    config.defaultRepositorySource,
  );

  // Parse the specifier
  const parsed = parseSource(hintedSpecifier);

  // Store the original source form (shorthand, SSH, HTTPS) — strip inline @ref (stored separately)
  const sourceForStorage = parsed.ref
    ? specifier.slice(0, -(parsed.ref.length + 1))
    : specifier;

  // Validate trust against the source
  validateTrustedSource(sourceForStorage, config.trust);

  // Determine ref (flag overrides inline @ref)
  const effectiveRef = ref ?? parsed.ref;
  const refOpts = effectiveRef ? { ref: effectiveRef } : {};

  async function addWildcard(): Promise<"*"> {
    if (
      config.skills.some(
        (s) =>
          isWildcardDep(s) && sourcesMatch(s.source, sourceForStorage),
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

  // --all: add a wildcard entry
  if (all) {
    if (namesOverride?.length) {
      throw new AddError("Cannot use --all with --name. Use one or the other.");
    }
    return addWildcard();
  }

  // Validate user-provided skill names before any filesystem operations
  if (namesOverride?.length) {
    for (const name of namesOverride) {
      if (!VALID_SKILL_NAME.test(name)) {
        throw new AddError(
          `Invalid skill name "${name}". Names must start with alphanumeric and contain only alphanumeric, dots, underscores, or hyphens.`,
        );
      }
    }
  }

  let skillName: string;

  if (parsed.type === "local") {
    // Local source — resolve the path
    const localDir = await resolveLocalSource(scope.root, parsed.path!);

    if (namesOverride?.length) {
      // User specified name(s), verify each exists in the local directory
      for (const name of namesOverride) {
        const found = await discoverSkill(localDir, name);
        if (!found) {
          throw new AddError(
            `Skill "${name}" not found in ${sourceForStorage}. ` +
              `Use 'dotagents add ${sourceForStorage}' without --name to see available skills.`,
          );
        }
      }

      if (namesOverride.length === 1) {
        skillName = namesOverride[0]!;
      } else {
        // Multiple names — skip existing, add the rest
        const toAdd: string[] = [];
        for (const name of namesOverride) {
          if (config.skills.some((s) => s.name === name)) {
            console.warn(
              chalk.yellow(`Skipping "${name}": already exists in agents.toml`),
            );
          } else {
            toAdd.push(name);
          }
        }

        if (toAdd.length === 0) {
          throw new AddError(
            "All specified skills already exist in agents.toml.",
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
    } else {
      // No names — load SKILL.md from root for the name
      const meta = await loadSkillMd(join(localDir, "SKILL.md"));
      skillName = meta.name;
    }
  } else {
    // Git source — clone and discover
    const url = parsed.url!;
    const cloneUrl = parsed.cloneUrl ?? url;
    const cacheKey =
      parsed.type === "github"
        ? `${parsed.owner}/${parsed.repo}`
        : url.replace(/^https?:\/\//, "").replace(/\.git$/, "");

    const cached = await ensureCached({
      url: cloneUrl,
      cacheKey,
      ref: effectiveRef,
    });

    if (namesOverride?.length) {
      // User specified name(s), verify each exists
      for (const name of namesOverride) {
        const found = await discoverSkill(cached.repoDir, name);
        if (!found) {
          throw new AddError(
            `Skill "${name}" not found in ${sourceForStorage}. ` +
              `Use 'dotagents add ${sourceForStorage}' without --name to see available skills.`,
          );
        }
      }

      if (namesOverride.length === 1) {
        skillName = namesOverride[0]!;
      } else {
        // Multiple names — skip existing, add the rest
        const toAdd: string[] = [];
        for (const name of namesOverride) {
          if (config.skills.some((s) => s.name === name)) {
            console.warn(
              chalk.yellow(`Skipping "${name}": already exists in agents.toml`),
            );
          } else {
            toAdd.push(name);
          }
        }

        if (toAdd.length === 0) {
          throw new AddError(
            "All specified skills already exist in agents.toml.",
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
    } else {
      // Discover all skills and pick
      const skills = await discoverAllSkills(cached.repoDir);
      if (skills.length === 0) {
        throw new AddError(`No skills found in ${sourceForStorage}.`);
      }
      if (skills.length === 1) {
        skillName = skills[0]!.meta.name;
      } else if (interactive) {
        // Interactive TTY — ask whether to add all or select specific skills
        const mode = await clack.select({
          message: `Multiple skills found in ${sourceForStorage}. How would you like to add them?`,
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

        if (clack.isCancel(mode)) {
          throw new AddCancelledError();
        }

        if (mode === "all") {
          return addWildcard();
        }

        const selected = await clack.multiselect({
          message: "Select which skills to add:",
          options: skills
            .toSorted((a, b) => a.meta.name.localeCompare(b.meta.name))
            .map((s) => {
              const lastSlash = s.path.lastIndexOf("/");
              const parentPath = lastSlash === -1 ? "" : s.path.slice(0, lastSlash);
              const pathHint = STANDARD_PARENTS.has(parentPath)
                ? ""
                : chalk.dim(`(${s.path}) `);
              return {
                label: s.meta.name,
                value: s.meta.name,
                hint: pathHint + s.meta.description,
              };
            }),
          required: true,
        });

        if (clack.isCancel(selected)) {
          throw new AddCancelledError();
        }

        if (selected.length === 1) {
          skillName = selected[0]!;
        } else {
          // Multiple selected — add each individually
          const added: string[] = [];
          for (const name of selected) {
            if (config.skills.some((s) => s.name === name)) {continue;}
            await addSkillToConfig(configPath, name, {
              source: sourceForStorage,
              ...refOpts,
            });
            added.push(name);
          }
          if (added.length === 0) {
            throw new AddError(
              "All selected skills already exist in agents.toml.",
            );
          }
          await runInstall({ scope });
          return added;
        }
      } else {
        // Non-interactive — list them and ask user to re-run with skill names or --all
        const names = skills.map((s) => s.meta.name).toSorted();
        throw new AddError(
          `Multiple skills found in ${sourceForStorage}: ${names.join(", ")}. ` +
            `Specify skill names as arguments, use --skill to specify which ones, or --all for all skills.`,
        );
      }
    }
  }

  // Check if skill already exists in config
  if (config.skills.some((s) => s.name === skillName)) {
    throw new AddError(
      `Skill "${skillName}" already exists in agents.toml. Remove it first to re-add.`,
    );
  }

  // Add to config
  await addSkillToConfig(configPath, skillName, {
    source: sourceForStorage,
    ...refOpts,
  });

  // Run install to actually fetch and place the skill
  await runInstall({ scope });

  return skillName;
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
        "Usage: dotagents add <specifier> [<skill>...] [--skill <name>...] [--ref <ref>] [--all]",
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
    if (
      err instanceof ScopeError ||
      err instanceof AddError ||
      err instanceof TrustError
    ) {
      console.error(chalk.red(err.message));
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}
