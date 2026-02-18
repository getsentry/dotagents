import { resolve } from "node:path";
import { parseArgs } from "node:util";
import chalk from "chalk";
import { loadConfig } from "../../config/loader.js";
import { isWildcardDep } from "../../config/schema.js";
import { addSkillToConfig, addWildcardToConfig } from "../../config/writer.js";
import { parseSource, resolveSkill } from "../../skills/resolver.js";
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

export interface AddOptions {
  scope: ScopeRoot;
  specifier: string;
  ref?: string;
  name?: string;
  all?: boolean;
}

export async function runAdd(opts: AddOptions): Promise<string> {
  const { scope, specifier, ref, name: nameOverride, all } = opts;
  const { configPath } = scope;

  // Load config early so we can check trust before any network work
  const config = await loadConfig(configPath);

  // Validate trust before resolution
  validateTrustedSource(specifier, config.trust);

  // Parse the specifier
  const parsed = parseSource(specifier);

  // Determine ref (flag overrides inline @ref)
  const effectiveRef = ref ?? parsed.ref;

  // --all: add a wildcard entry
  if (all) {
    if (nameOverride) {
      throw new AddError("Cannot use --all with --name. Use one or the other.");
    }

    if (config.skills.some((s) => isWildcardDep(s) && s.source === specifier)) {
      throw new AddError(
        `A wildcard entry for "${specifier}" already exists in agents.toml.`,
      );
    }

    await addWildcardToConfig(configPath, specifier, {
      ...(effectiveRef ? { ref: effectiveRef } : {}),
      exclude: [],
    });

    await runInstall({ scope });
    return "*";
  }

  // For git sources, resolve to discover the skill name
  let skillName: string;

  if (parsed.type === "local") {
    // Local source — resolve and read SKILL.md for the name
    const resolved = await resolveSkill(
      nameOverride ?? "unknown",
      { source: specifier },
      { projectRoot: scope.root },
    );
    if (resolved.type !== "local") throw new AddError("Unexpected resolve type for local source");

    const { loadSkillMd } = await import("../../skills/loader.js");
    const { join: pathJoin } = await import("node:path");
    const meta = await loadSkillMd(pathJoin(resolved.skillDir, "SKILL.md"));
    skillName = nameOverride ?? meta.name;
  } else {
    // Git source — clone and discover
    const url = parsed.url!;
    const cacheKey =
      parsed.type === "github"
        ? `${parsed.owner}/${parsed.repo}`
        : url.replace(/^https?:\/\//, "").replace(/\.git$/, "");

    const cached = await ensureCached({ url, cacheKey, ref: effectiveRef });

    if (nameOverride) {
      // User specified name, verify it exists
      const { discoverSkill } = await import("../../skills/discovery.js");
      const found = await discoverSkill(cached.repoDir, nameOverride);
      if (!found) {
        throw new AddError(
          `Skill "${nameOverride}" not found in ${specifier}. ` +
            `Use 'dotagents add ${specifier}' without --name to see available skills.`,
        );
      }
      skillName = nameOverride;
    } else {
      // Discover all skills and pick
      const skills = await discoverAllSkills(cached.repoDir);
      if (skills.length === 0) {
        throw new AddError(`No skills found in ${specifier}.`);
      }
      if (skills.length === 1) {
        skillName = skills[0]!.meta.name;
      } else {
        // Multiple skills found — list them and ask user to pick with --name or --all
        const names = skills.map((s) => s.meta.name).sort();
        throw new AddError(
          `Multiple skills found in ${specifier}: ${names.join(", ")}. ` +
            `Use --name to specify which one, or --all for all skills.`,
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
    source: specifier,
    ...(effectiveRef ? { ref: effectiveRef } : {}),
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
      name: { type: "string" },
      skill: { type: "string" },
      all: { type: "boolean" },
    },
    strict: true,
  });

  const nameValue = values["name"] ?? values["skill"];

  const specifier = positionals[0];
  if (!specifier) {
    console.error(chalk.red("Usage: dotagents add <specifier> [--ref <ref>] [--name <name>] [--all]"));
    process.exitCode = 1;
    return;
  }

  try {
    const scope = flags?.user ? resolveScope("user") : resolveDefaultScope(resolve("."));
    const name = await runAdd({
      scope,
      specifier,
      ref: values["ref"],
      name: nameValue,
      all: values["all"],
    });
    const msg = name === "*" ? `Added all skills from ${specifier}` : `Added skill: ${name}`;
    console.log(chalk.green(msg));
  } catch (err) {
    if (err instanceof ScopeError || err instanceof AddError || err instanceof TrustError) {
      console.error(chalk.red(err.message));
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}
