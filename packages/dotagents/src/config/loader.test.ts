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

  it("loads a representative config and applies collection defaults", async () => {
    const configPath = join(dir, "agents.toml");
    await writeFile(
      configPath,
      `version = 1
agents = ["claude", "cursor", "codex", "grok", "opencode", "pi"]

[symlinks]
targets = [".legacy"]

[[skills]]
name = "pdf"
source = "anthropics/skills"
ref = "v1.0.0"

[[skills]]
name = "*"
source = "getsentry/skills"
exclude = ["deprecated"]

[[skills]]
name = "*"
source = "anthropics/catalog"

[[mcp]]
name = "github"
command = "npx"
args = ["-y", "@mcp/server-github"]
env = ["GITHUB_TOKEN"]

[[subagents]]
name = "code-reviewer"
source = "getsentry/agents"
targets = ["claude", "codex", "opencode"]

[[plugins]]
name = "review-tools"
source = "getsentry/plugins"
targets = ["claude", "codex", "cursor", "grok", "opencode", "pi"]
`,
    );

    const config = await loadConfig(configPath);
    expect(config.version).toBe(1);
    expect(config.symlinks?.targets).toEqual([".legacy"]);
    expect(config.agents).toEqual([
      "claude",
      "cursor",
      "codex",
      "grok",
      "opencode",
      "pi",
    ]);
    expect(config.skills.find((skill) => skill.name === "pdf")).toMatchObject({
      source: "anthropics/skills",
      ref: "v1.0.0",
    });
    expect(
      config.skills.find(
        (skill) => skill.name === "*" && skill.source === "getsentry/skills",
      ),
    ).toMatchObject({ exclude: ["deprecated"] });
    expect(
      config.skills.find(
        (skill) => skill.name === "*" && skill.source === "anthropics/catalog",
      ),
    ).toMatchObject({ exclude: [] });
    expect(config.mcp).toEqual([
      {
        name: "github",
        command: "npx",
        args: ["-y", "@mcp/server-github"],
        env: ["GITHUB_TOKEN"],
      },
    ]);
    expect(config.subagents).toEqual([
      {
        name: "code-reviewer",
        source: "getsentry/agents",
        targets: ["claude", "codex", "opencode"],
      },
    ]);
    expect(config.plugins).toEqual([
      {
        name: "review-tools",
        source: "getsentry/plugins",
        targets: ["claude", "codex", "cursor", "grok", "opencode", "pi"],
      },
    ]);
  });

  it("throws ConfigError for a missing file", async () => {
    await expect(loadConfig(join(dir, "nope.toml"))).rejects.toThrow(
      ConfigError,
    );
  });

  it("throws ConfigError for invalid TOML", async () => {
    const configPath = join(dir, "agents.toml");
    await writeFile(configPath, "this is not valid toml {{{}");

    await expect(loadConfig(configPath)).rejects.toThrow(ConfigError);
  });

  it("throws ConfigError for a schema violation", async () => {
    const configPath = join(dir, "agents.toml");
    await writeFile(configPath, 'version = 99\nfoo = "bar"\n');

    await expect(loadConfig(configPath)).rejects.toThrow(ConfigError);
  });

  it("rejects unknown agent IDs", async () => {
    const configPath = join(dir, "agents.toml");
    await writeFile(configPath, `version = 1\nagents = ["claude", "emacs"]\n`);

    await expect(loadConfig(configPath)).rejects.toThrow(/Unknown agent.*emacs/);
  });

  it("rejects duplicate wildcard sources", async () => {
    const configPath = join(dir, "agents.toml");
    await writeFile(
      configPath,
      `version = 1\n\n[[skills]]\nname = "*"\nsource = "getsentry/skills"\n\n[[skills]]\nname = "*"\nsource = "getsentry/skills"\n`,
    );

    await expect(loadConfig(configPath)).rejects.toThrow(/Duplicate wildcard source/);
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

  it("rejects configured agents that do not support plugin outputs as plugin targets", async () => {
    const configPath = join(dir, "agents.toml");
    await writeFile(
      configPath,
      `version = 1
agents = ["vscode"]

[[plugins]]
name = "review-tools"
source = "getsentry/plugins"
targets = ["vscode"]
`,
    );

    await expect(loadConfig(configPath)).rejects.toThrow(/Unknown plugin target.*vscode/);
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
