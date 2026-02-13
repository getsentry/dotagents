import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, ConfigError } from "./loader.js";

describe("loadConfig", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "dotagents-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true });
  });

  it("loads a valid config", async () => {
    const configPath = join(dir, "agents.toml");
    await writeFile(
      configPath,
      `version = 1

[[skills]]
name = "pdf"
source = "anthropics/skills"
ref = "v1.0.0"
`,
    );

    const config = await loadConfig(configPath);
    expect(config.version).toBe(1);
    const pdf = config.skills.find((s) => s.name === "pdf");
    expect(pdf?.source).toBe("anthropics/skills");
    expect(pdf?.ref).toBe("v1.0.0");
  });

  it("loads a minimal config", async () => {
    const configPath = join(dir, "agents.toml");
    await writeFile(configPath, "version = 1\n");

    const config = await loadConfig(configPath);
    expect(config.version).toBe(1);
    expect(config.skills).toEqual([]);
  });

  it("throws ConfigError for missing file", async () => {
    await expect(loadConfig(join(dir, "nope.toml"))).rejects.toThrow(
      ConfigError,
    );
  });

  it("throws ConfigError for invalid TOML", async () => {
    const configPath = join(dir, "agents.toml");
    await writeFile(configPath, "this is not valid toml {{{}");

    await expect(loadConfig(configPath)).rejects.toThrow(ConfigError);
  });

  it("throws ConfigError for wrong schema", async () => {
    const configPath = join(dir, "agents.toml");
    await writeFile(configPath, 'version = 99\nfoo = "bar"\n');

    await expect(loadConfig(configPath)).rejects.toThrow(ConfigError);
  });

  it("parses symlinks config", async () => {
    const configPath = join(dir, "agents.toml");
    await writeFile(
      configPath,
      `version = 1

[symlinks]
targets = [".claude"]
`,
    );

    const config = await loadConfig(configPath);
    expect(config.symlinks?.targets).toEqual([".claude"]);
  });

  it("loads config with agents and mcp", async () => {
    const configPath = join(dir, "agents.toml");
    await writeFile(
      configPath,
      `version = 1
agents = ["claude", "cursor"]

[[mcp]]
name = "github"
command = "npx"
args = ["-y", "@mcp/server-github"]
env = ["GITHUB_TOKEN"]
`,
    );

    const config = await loadConfig(configPath);
    expect(config.agents).toEqual(["claude", "cursor"]);
    expect(config.mcp).toHaveLength(1);
    expect(config.mcp[0]!.name).toBe("github");
  });

  it("rejects unknown agent IDs", async () => {
    const configPath = join(dir, "agents.toml");
    await writeFile(configPath, `version = 1\nagents = ["claude", "emacs"]\n`);

    await expect(loadConfig(configPath)).rejects.toThrow(/Unknown agent.*emacs/);
  });
});
