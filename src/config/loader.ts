import { readFile } from "node:fs/promises";
import { parse as parseTOML } from "smol-toml";
import { agentsConfigSchema } from "./schema.js";
import type { AgentsConfig } from "./schema.js";
import { allAgentIds } from "../agents/registry.js";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export async function loadConfig(filePath: string): Promise<AgentsConfig> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch {
    throw new ConfigError(`Config file not found: ${filePath}`);
  }

  let parsed: unknown;
  try {
    parsed = parseTOML(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ConfigError(`Invalid TOML in ${filePath}: ${message}`);
  }

  const result = agentsConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new ConfigError(`Invalid config in ${filePath}:\n${issues}`);
  }

  // Post-parse validation: reject unknown agent IDs
  const validIds = allAgentIds();
  const unknown = result.data.agents.filter((id) => !validIds.includes(id));
  if (unknown.length > 0) {
    throw new ConfigError(
      `Unknown agent(s) in ${filePath}: ${unknown.join(", ")}. Valid agents: ${validIds.join(", ")}`,
    );
  }

  return result.data;
}
