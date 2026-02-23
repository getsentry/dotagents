import { resolve } from "node:path";
import { parseArgs } from "node:util";
import * as clack from "@clack/prompts";
import chalk from "chalk";
import { loadConfig } from "../../config/loader.js";
import { isWildcardDep } from "../../config/schema.js";
import { addSkillToConfig, addWildcardToConfig } from "../../config/writer.js";
import { parseSource, resolveSkill, sourcesMatch } from "../../skills/resolver.js";
import { discoverAllSkills } from "../../skills/discovery.js";
import { ensureCached } from "../../sources/cache.js";
import { validateTrustedSource, TrustError } from "../../trust/index.js";
import { runInstall } from "./install.js";
import { resolveScope, resolveDefaultScope, ScopeError } from "../../scope.js";
import type { ScopeRoot } from "../../scope.js";

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
  const { scope, specifier, ref, names: namesOverride, all, interactive } = opts;
  const { configPath } = scope;

  // Load config early so we can check trust before any network work
  const config = await loadConfig(configPath);

  // Parse the specifier
  const parsed = parseSource(specifier);

  // Preserve original source form (SSH, HTTPS, or shorthand) — strip inline @ref (stored separately)
  const sourceForStorage =
    parsed.type === "github" && parsed.ref
      ? specifier.slice(0, -(parsed.ref.length + 1))
      : specifier;

  // Validate trust against the source
  validateTrustedSource(sourceForStorage, config.trust);

  // Determine ref (flag overrides inline @ref)
  const effectiveRef = ref ?? parsed.ref;
  const refOpts = effectiveRef ? { ref: effectiveRef } : {};

  // --all: add a wildcard entry
  if (all) {
    if (namesOverride?.length) {
      throw new AddError("Cannot use --all with --name. Use one or the other.");
    }

    if (config.skills.some((s) => isWildcardDep(s) && sourcesMatch(s.source, sourceForStorage))) {
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

  // For git sources, resolve to discover the skill name
  let skillName: string;

  if (parsed.type === "local") {
    // Local source — resolve and read SKILL.md for the name
    const singleName = namesOverride?.[0];
    const resolved = await resolveSkill(
      singleName ?? "unknown",
      { source: specifier },
      { projectRoot: scope.root },
    );
    if (resolved.type !== "local") throw new AddError("Unexpected resolve type for local source");

    const { loadSkillMd } = await import("../../skills/loader.js");
    const { join: pathJoin } = await import("node:path");
    const meta = await loadSkillMd(pathJoin(resolved.skillDir, "SKILL.md"));
    skillName = singleName ?? meta.name;
  } else {
    // Git source — clone and discover
    const url = parsed.url!;
    const cloneUrl = parsed.cloneUrl ?? url;
    const cacheKey =
      parsed.type === "github"
        ? `${parsed.owner}/${parsed.repo}`
        : url.replace(/^https?:\/\//, "").replace(/\.git$/, "");

    const cached = await ensureCached({ url: cloneUrl, cacheKey, ref: effectiveRef });

    if (namesOverride?.length) {
      // User specified name(s), verify each exists
      const { discoverSkill } = await import("../../skills/discovery.js");

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
        // Multiple names — check for duplicates, add each, install once
        for (const name of namesOverride) {
          if (config.skills.some((s) => s.name === name)) {
            throw new AddError(
              `Skill "${name}" already exists in agents.toml. Remove it first or use 'dotagents update'.`,
            );
          }
          await addSkillToConfig(configPath, name, {
            source: sourceForStorage,
            ...refOpts,
          });
        }
        await runInstall({ scope });
        return namesOverride;
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
        // Interactive TTY — let user pick from a list
        const selected = await clack.multiselect({
          message: `Multiple skills found in ${sourceForStorage}. Select which to add:`,
          options: skills
            .sort((a, b) => a.meta.name.localeCompare(b.meta.name))
            .map((s) => ({
              label: s.meta.name,
              value: s.meta.name,
              hint: s.meta.description,
            })),
          required: true,
        });

        if (clack.isCancel(selected)) {
          throw new AddCancelledError();
        }

        if (selected.length === skills.length) {
          // All selected — add wildcard entry
          if (config.skills.some((s) => isWildcardDep(s) && sourcesMatch(s.source, sourceForStorage))) {
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

        if (selected.length === 1) {
          skillName = selected[0]!;
        } else {
          // Multiple (but not all) selected — add each individually
          const added: string[] = [];
          for (const name of selected) {
            if (config.skills.some((s) => s.name === name)) continue;
            await addSkillToConfig(configPath, name, {
              source: sourceForStorage,
              ...refOpts,
            });
            added.push(name);
          }
          if (added.length === 0) {
            throw new AddError("All selected skills already exist in agents.toml.");
          }
          await runInstall({ scope });
          return added;
        }
      } else {
        // Non-interactive — list them and ask user to re-run with skill names or --all
        const names = skills.map((s) => s.meta.name).sort();
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
      `Skill "${skillName}" already exists in agents.toml. Remove it first or use 'dotagents update'.`,
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

export default async function add(args: string[], flags?: { user?: boolean }): Promise<void> {
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
      chalk.red("Usage: dotagents add <specifier> [<skill>...] [--skill <name>...] [--ref <ref>] [--all]"),
    );
    process.exitCode = 1;
    return;
  }

  // Collect skill names from positional args and flags
  const positionalNames = positionals.slice(1);
  const flagNames = [...(values["name"] ?? []), ...(values["skill"] ?? [])];

  if (positionalNames.length > 0 && flagNames.length > 0) {
    console.error(
      chalk.red("Cannot mix positional skill names with --skill/--name flags. Use one or the other."),
    );
    process.exitCode = 1;
    return;
  }

  const rawNames = [...positionalNames, ...flagNames];
  const names = rawNames.length > 0 ? [...new Set(rawNames)] : undefined;

  try {
    const scope = flags?.user ? resolveScope("user") : resolveDefaultScope(resolve("."));
    const interactive = process.stdout.isTTY === true && !names && !values["all"];
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
    if (err instanceof AddCancelledError) return;
    if (err instanceof ScopeError || err instanceof AddError || err instanceof TrustError) {
      console.error(chalk.red(err.message));
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}
