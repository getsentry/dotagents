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

  it("loads a wildcard skill entry", async () => {
    const configPath = join(dir, "agents.toml");
    await writeFile(
      configPath,
      `version = 1\n\n[[skills]]\nname = "*"\nsource = "getsentry/skills"\n`,
    );

    const config = await loadConfig(configPath);
    expect(config.skills).toHaveLength(1);
    expect(config.skills[0]!.name).toBe("*");
    expect(config.skills[0]!.source).toBe("getsentry/skills");
  });

  it("loads wildcard with exclude list", async () => {
    const configPath = join(dir, "agents.toml");
    await writeFile(
      configPath,
      `version = 1\n\n[[skills]]\nname = "*"\nsource = "getsentry/skills"\nexclude = ["deprecated"]\n`,
    );

    const config = await loadConfig(configPath);
    const dep = config.skills[0]!;
    expect(dep.name).toBe("*");
    expect("exclude" in dep && dep.exclude).toEqual(["deprecated"]);
  });

  it("defaults exclude to empty array", async () => {
    const configPath = join(dir, "agents.toml");
    await writeFile(
      configPath,
      `version = 1\n\n[[skills]]\nname = "*"\nsource = "getsentry/skills"\n`,
    );

    const config = await loadConfig(configPath);
    const dep = config.skills[0]!;
    expect("exclude" in dep && dep.exclude).toEqual([]);
  });

  it("rejects duplicate wildcard sources", async () => {
    const configPath = join(dir, "agents.toml");
    await writeFile(
      configPath,
      `version = 1\n\n[[skills]]\nname = "*"\nsource = "getsentry/skills"\n\n[[skills]]\nname = "*"\nsource = "getsentry/skills"\n`,
    );

    await expect(loadConfig(configPath)).rejects.toThrow(/Duplicate wildcard source/);
  });

  it("allows wildcards from different sources", async () => {
    const configPath = join(dir, "agents.toml");
    await writeFile(
      configPath,
      `version = 1\n\n[[skills]]\nname = "*"\nsource = "getsentry/skills"\n\n[[skills]]\nname = "*"\nsource = "anthropics/skills"\n`,
    );

    const config = await loadConfig(configPath);
    expect(config.skills).toHaveLength(2);
  });

  it("allows mixing wildcard and regular entries", async () => {
    const configPath = join(dir, "agents.toml");
    await writeFile(
      configPath,
      `version = 1\n\n[[skills]]\nname = "*"\nsource = "getsentry/skills"\n\n[[skills]]\nname = "pdf"\nsource = "anthropics/skills"\n`,
    );

    const config = await loadConfig(configPath);
    expect(config.skills).toHaveLength(2);
  });

  it("loads subagent entries", async () => {
    const configPath = join(dir, "agents.toml");
    await writeFile(
      configPath,
      `version = 1
agents = ["claude", "codex", "opencode"]

[[subagents]]
name = "code-reviewer"
source = "getsentry/agents"
targets = ["claude", "codex", "opencode"]
`,
    );

    const config = await loadConfig(configPath);
    expect(config.subagents).toHaveLength(1);
    expect(config.subagents[0]!.targets).toEqual(["claude", "codex", "opencode"]);
    expect(config.subagents[0]!.source).toBe("getsentry/agents");
  });

  it("rejects unknown subagent targets", async () => {
    const configPath = join(dir, "agents.toml");
    await writeFile(
      configPath,
      `version = 1

[[subagents]]
name = "reviewer"
source = "getsentry/agents"
targets = ["emacs"]
`,
    );

    await expect(loadConfig(configPath)).rejects.toThrow(/Unknown subagent target/);
  });

  it("rejects duplicate subagent names", async () => {
    const configPath = join(dir, "agents.toml");
    await writeFile(
      configPath,
      `version = 1

[[subagents]]
name = "reviewer"
source = "getsentry/agents"

[[subagents]]
name = "reviewer"
source = "getsentry/agents"
`,
    );

    await expect(loadConfig(configPath)).rejects.toThrow(/Duplicate subagent/);
  });

  it("rejects HTTPS well-known subagent sources", async () => {
    const configPath = join(dir, "agents.toml");
    await writeFile(
      configPath,
      `version = 1

[[subagents]]
name = "reviewer"
source = "https://agents.example.com"
`,
    );

    await expect(loadConfig(configPath)).rejects.toThrow(/unsupported HTTPS well-known source/);
  });

  it("loads plugin entries", async () => {
    const configPath = join(dir, "agents.toml");
    await writeFile(
      configPath,
      `version = 1
agents = ["claude", "codex", "cursor", "grok", "opencode"]

[[plugins]]
name = "review-tools"
source = "getsentry/plugins"
targets = ["claude", "codex", "cursor", "grok", "opencode"]
`,
    );

    const config = await loadConfig(configPath);
    expect(config.plugins).toHaveLength(1);
    expect(config.plugins[0]!.targets).toEqual(["claude", "codex", "cursor", "grok", "opencode"]);
    expect(config.plugins[0]!.source).toBe("getsentry/plugins");
  });

  it("rejects unknown plugin targets", async () => {
    const configPath = join(dir, "agents.toml");
    await writeFile(
      configPath,
      `version = 1

[[plugins]]
name = "review-tools"
source = "getsentry/plugins"
targets = ["emacs"]
`,
    );

    await expect(loadConfig(configPath)).rejects.toThrow(/Unknown plugin target/);
  });

  it("rejects duplicate plugin names", async () => {
    const configPath = join(dir, "agents.toml");
    await writeFile(
      configPath,
      `version = 1

[[plugins]]
name = "review-tools"
source = "getsentry/plugins"

[[plugins]]
name = "review-tools"
source = "getsentry/plugins"
`,
    );

    await expect(loadConfig(configPath)).rejects.toThrow(/Duplicate plugin/);
  });

  it("rejects HTTPS well-known plugin sources", async () => {
    const configPath = join(dir, "agents.toml");
    await writeFile(
      configPath,
      `version = 1

[[plugins]]
name = "review-tools"
source = "https://plugins.example.com"
`,
    );

    await expect(loadConfig(configPath)).rejects.toThrow(/unsupported HTTPS well-known source/);
  });
});
