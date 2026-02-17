import { resolve } from "node:path";
import { parseArgs } from "node:util";
import chalk from "chalk";
import { loadConfig } from "../../config/loader.js";
import { addSkillToConfig } from "../../config/writer.js";
import { parseSource, resolveSkill } from "../../skills/resolver.js";
import { discoverAllSkills } from "../../skills/discovery.js";
import { ensureCached } from "../../sources/cache.js";
import { validateTrustedSource, TrustError } from "../../trust/index.js";
import { runInstall } from "./install.js";
import { resolveScope } from "../../scope.js";
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
}

export async function runAdd(opts: AddOptions): Promise<string> {
  const { scope, specifier, ref, name: nameOverride } = opts;
  const { configPath } = scope;

  // Load config early so we can check trust before any network work
  const config = await loadConfig(configPath);

  // Validate trust before resolution
  validateTrustedSource(specifier, config.trust);

  // Parse the specifier
  const parsed = parseSource(specifier);

  // Determine ref (flag overrides inline @ref)
  const effectiveRef = ref ?? parsed.ref;

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
        // Multiple skills found — for now, list them and ask user to pick with --name
        const names = skills.map((s) => s.meta.name).sort();
        throw new AddError(
          `Multiple skills found in ${specifier}: ${names.join(", ")}. ` +
            `Use --name to specify which one.`,
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

  // Build the source string for agents.toml
  const source = specifier;
  // If ref was provided inline (@ref), strip it from source since we'll use the ref field
  if (parsed.ref && !ref) {
    // Inline ref — keep it in source as-is
  } else if (effectiveRef && !specifier.includes("@")) {
    // Ref from --ref flag, not inline
  }

  // Add to config
  await addSkillToConfig(configPath, skillName, {
    source,
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
    },
    strict: true,
  });

  const nameValue = values["name"] ?? values["skill"];

  const specifier = positionals[0];
  if (!specifier) {
    console.error(chalk.red("Usage: dotagents add <specifier> [--ref <ref>] [--name <name>]"));
    process.exitCode = 1;
    return;
  }

  try {
    const scope = resolveScope(flags?.user ? "user" : "project", resolve("."));
    const name = await runAdd({
      scope,
      specifier,
      ref: values["ref"],
      name: nameValue,
    });
    console.log(chalk.green(`Added skill: ${name}`));
  } catch (err) {
    if (err instanceof AddError || err instanceof TrustError) {
      console.error(chalk.red(err.message));
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}
