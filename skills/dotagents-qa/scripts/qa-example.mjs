#!/usr/bin/env node
// Task-oriented agentic QA for the checked-in dotagents example. Keep this
// script with the dotagents-qa skill so runtime proof stays beside its docs.

import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");
const cliPath = join(repoRoot, "packages", "dotagents", "dist", "cli", "index.js");
const exampleRoot = join(repoRoot, "examples", "full");
const sentinel = "DOTAGENTS_SUBAGENT_RUNTIME_PROOF_9b8e6f2c";

const rawArgs = process.argv.slice(2);
const flags = new Set(rawArgs.filter((arg) => arg.startsWith("-")));
const keep = flags.has("--keep");
const task = taskName(rawArgs);

const taskGroups = {
  all: ["install-files", "sync-repair"],
};

const tasks = {
  "install-files": runInstallFiles,
  "sync-repair": runSyncRepair,
  "plugin-claude": runClaudePluginProof,
  "plugin-codex": runCodexPluginProof,
  "plugin-grok": runGrokPluginProof,
  "opencode-projections": runOpenCodePluginProof,
  "plugin-clients": runAvailablePluginClientProofs,
  "codex-runtime": runCodexRuntimeProof,
};

if (flags.has("--help") || flags.has("-h")) {
  printUsage();
  process.exit(0);
}

if (!existsSync(cliPath)) {
  console.error(`qa-example: missing built CLI at ${cliPath}`);
  console.error("Run `pnpm build` first.");
  process.exit(1);
}

if (!tasks[task] && !taskGroups[task]) {
  console.error(`qa-example: unknown task "${task}"`);
  printUsage();
  process.exit(1);
}

const tmp = mkdtempSync(join(tmpdir(), "dotagents-example-"));
const projectDir = join(tmp, "project");
const homeDir = join(tmp, "home");
const stateDir = join(tmp, "state");
const dotagentsHomeDir = join(tmp, "dotagents-home");
const codexHomeDir = join(tmp, "codex-home");
mkdirSync(homeDir, { recursive: true });
mkdirSync(stateDir, { recursive: true });
mkdirSync(dotagentsHomeDir, { recursive: true });
cpSync(exampleRoot, projectDir, { recursive: true });

const fixtureEnv = {
  ...process.env,
  HOME: homeDir,
  DOTAGENTS_HOME: dotagentsHomeDir,
  DOTAGENTS_STATE_DIR: stateDir,
};

try {
  console.log(`qa-example: project=${projectDir}`);
  for (const name of expandedTasks(task)) {
    console.log(`qa-example: task=${name}`);
    await tasks[name]();
  }
  console.log("qa-example: ok");
} catch (err) {
  console.error("qa-example: failed");
  console.error(err instanceof Error ? err.message : String(err));
  console.error(`qa-example: project kept at ${projectDir}`);
  process.exitCode = 1;
  throw err;
} finally {
  rmSync(codexHomeDir, { recursive: true, force: true });
  if (!keep && process.exitCode !== 1) {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function taskName(args) {
  if (flags.has("--codex-runtime")) {return "codex-runtime";}
  return args.find((arg) => !arg.startsWith("-")) ?? "all";
}

function expandedTasks(name) {
  return taskGroups[name] ?? [name];
}

function printUsage() {
  console.error(`Usage: node skills/dotagents-qa/scripts/qa-example.mjs <task> [--keep]

Tasks:
  all              Run install-files and sync-repair
  install-files    Install the full example and assert generated files
  sync-repair      Delete representative generated files and assert sync repairs them
  plugin-claude    Validate generated Claude plugin and marketplace with Claude Code
  plugin-codex     Add/list/install generated Codex marketplace with Codex CLI
  plugin-grok      Confirm Grok Build discovers the generated project plugin
  opencode-projections  Assert generated OpenCode resource projections
  plugin-clients   Run every installed no-auth plugin client proof
  codex-runtime    Paid proof that Codex can spawn the generated custom agent

Compatibility:
  --codex-runtime  Alias for the codex-runtime task
`);
}

async function runInstallFiles() {
  await installAndAssert();
}

async function runSyncRepair() {
  await installAndAssert();
  rmSync(join(projectDir, ".mcp.json"), { force: true });
  rmSync(join(projectDir, ".claude", "skills"), { force: true, recursive: true });
  rmSync(join(projectDir, ".claude", "agents", "code-reviewer.md"), { force: true });
  rmSync(join(projectDir, ".codex", "agents", "code-reviewer.toml"), { force: true });
  rmSync(join(projectDir, ".agents", "plugins", "marketplace.json"), { force: true });
  rmSync(join(projectDir, ".claude-plugin", "marketplace.json"), { force: true });
  rmSync(join(projectDir, ".cursor-plugin", "marketplace.json"), { force: true });
  rmSync(join(projectDir, ".agents", "plugins", "qa-tools", ".claude-plugin", "plugin.json"), { force: true });
  rmSync(join(projectDir, ".agents", "plugins", "qa-tools", ".cursor-plugin", "plugin.json"), { force: true });
  rmSync(join(projectDir, ".agents", "plugins", "qa-tools", ".codex-plugin", "plugin.json"), { force: true });
  rmSync(join(projectDir, ".grok", "plugins", "qa-tools"), { force: true, recursive: true });
  rmSync(join(projectDir, ".opencode", "skills", "plugin-qa"), { force: true, recursive: true });
  rmSync(join(projectDir, ".agents", "skills", "plugin-qa"), { force: true, recursive: true });
  runCli(["sync"]);
  assertFile(".mcp.json");
  assertSymlink(".claude/skills");
  assertFile(".claude/agents/code-reviewer.md");
  assertFile(".codex/agents/code-reviewer.toml");
  assertPluginOutputs();
}

async function runClaudePluginProof() {
  prepareClientHarness("claude");
  execFileSync("claude", ["plugin", "validate", join(projectDir, ".agents", "plugins", "qa-tools")], {
    cwd: projectDir,
    env: fixtureEnv,
    stdio: "inherit",
  });
  execFileSync("claude", ["plugin", "validate", join(projectDir, ".claude-plugin", "marketplace.json")], {
    cwd: projectDir,
    env: fixtureEnv,
    stdio: "inherit",
  });
  execFileSync("claude", ["plugin", "marketplace", "add", projectDir, "--scope", "local"], {
    cwd: projectDir,
    env: fixtureEnv,
    stdio: "inherit",
  });
  const available = execJson("claude", ["plugin", "list", "--available", "--json"], fixtureEnv);
  if (!available.available?.some((plugin) => plugin.pluginId === "qa-tools@dotagents")) {
    throw new Error("Claude available plugin list did not include qa-tools@dotagents");
  }
  execFileSync("claude", ["plugin", "install", "qa-tools@dotagents", "--scope", "local"], {
    cwd: projectDir,
    env: fixtureEnv,
    stdio: "inherit",
  });
  const installed = execJson("claude", ["plugin", "list", "--json"], fixtureEnv);
  const plugin = installed.find((entry) => entry.id === "qa-tools@dotagents" && entry.enabled === true);
  if (!plugin) {throw new Error("Claude installed plugin list did not include enabled qa-tools@dotagents");}
  const mcpNames = Object.keys(plugin.mcpServers ?? {}).toSorted();
  if (JSON.stringify(mcpNames) !== JSON.stringify(["fixture-http", "fixture-stdio"])) {
    throw new Error(`Claude installed plugin MCP servers were unexpected: ${mcpNames.join(", ")}`);
  }
  const details = execFileSync("claude", ["plugin", "details", "qa-tools"], {
    cwd: projectDir,
    env: fixtureEnv,
    encoding: "utf-8",
  });
  assertIncludes(details, "Skills (1)  plugin-qa", "Claude details should include one plugin skill");
  assertIncludes(details, "Agents (0)", "Claude details should not include client-extension agents");
}

async function runAvailablePluginClientProofs() {
  const proofs = [
    ["claude", runClaudePluginProof],
    ["codex", runCodexPluginProof],
    ["grok", runGrokPluginProof],
  ];
  let ran = 0;
  for (const [command, proof] of proofs) {
    if (!commandAvailable(command)) {
      console.log(`qa-example: skip=${command} (not installed)`);
      continue;
    }
    console.log(`qa-example: client=${command}`);
    await proof();
    ran++;
  }
  if (ran === 0) {
    throw new Error("No supported plugin client CLI is installed");
  }
}

async function runGrokPluginProof() {
  prepareClientHarness("grok");
  const list = execFileSync("grok", ["plugin", "list"], {
    cwd: projectDir,
    env: fixtureEnv,
    encoding: "utf-8",
  });
  if (!list.includes("qa-tools")) {
    throw new Error("Grok plugin list did not include qa-tools");
  }
  const info = execFileSync("grok", ["plugin", "details", "qa-tools"], {
    cwd: projectDir,
    env: fixtureEnv,
    encoding: "utf-8",
  });
  if (!info.includes("qa-tools")) {
    throw new Error("Grok plugin details did not describe qa-tools");
  }
}

async function runCodexPluginProof() {
  prepareClientHarness("codex");
  rmSync(codexHomeDir, { recursive: true, force: true });
  mkdirSync(codexHomeDir, { recursive: true });
  const env = { ...fixtureEnv, CODEX_HOME: codexHomeDir };

  const add = execJson("codex", ["plugin", "marketplace", "add", projectDir, "--json"], env);
  if (add.marketplaceName !== "dotagents-local") {
    throw new Error("Codex marketplace add did not return dotagents-local");
  }

  const available = execJson("codex", ["plugin", "list", "--available", "--json"], env);
  if (!available.available?.some((plugin) => plugin.pluginId === "qa-tools@dotagents-local")) {
    throw new Error("Codex available plugin list did not include qa-tools@dotagents-local");
  }

  const installed = execJson("codex", ["plugin", "add", "qa-tools@dotagents-local", "--json"], env);
  if (installed.pluginId !== "qa-tools@dotagents-local") {
    throw new Error("Codex plugin add did not install qa-tools@dotagents-local");
  }
  const installedMcp = JSON.parse(readFileSync(join(installed.installedPath, "mcp.json"), "utf-8"));
  const installedMcpNames = Object.keys(installedMcp.mcpServers ?? {}).toSorted();
  if (JSON.stringify(installedMcpNames) !== JSON.stringify(["fixture-http", "fixture-stdio"])) {
    throw new Error(`Codex installed plugin MCP servers were unexpected: ${installedMcpNames.join(", ")}`);
  }

  const list = execJson("codex", ["plugin", "list", "--json"], env);
  if (!list.installed?.some((plugin) => plugin.pluginId === "qa-tools@dotagents-local" && plugin.enabled === true)) {
    throw new Error("Codex installed plugin list did not include enabled qa-tools@dotagents-local");
  }
}

async function runOpenCodePluginProof() {
  prepareClientHarness("opencode");
  const skills = execFileSync("opencode", ["debug", "skill"], {
    cwd: projectDir,
    env: fixtureEnv,
    encoding: "utf-8",
  });
  assertSymlink(".opencode/skills/plugin-qa");
  assertFile(".opencode/skills/.dotagents-managed/plugin-qa");
  if (!skills.includes("plugin-qa") || !skills.includes("DOTAGENTS_PLUGIN_QA_FIXTURE")) {
    throw new Error("OpenCode debug skill did not include projected plugin skill");
  }
  const config = execJson("opencode", ["debug", "config"], fixtureEnv);
  const local = config.mcp?.["plugin.qa-tools.fixture-stdio"];
  const remote = config.mcp?.["plugin.qa-tools.fixture-http"];
  const pluginRoot = realpathSync(join(projectDir, ".agents", "plugins", "qa-tools"));
  const pluginData = realpathSync(join(projectDir, ".agents", "plugin-data", "qa-tools"));
  if (JSON.stringify(local) !== JSON.stringify({
    type: "local",
    command: ["node", join(pluginRoot, "server.mjs")],
    cwd: pluginRoot,
    environment: {
      PLUGIN_ROOT: pluginRoot,
      PLUGIN_DATA: pluginData,
      FIXTURE_CACHE: join(pluginData, "cache"),
    },
  })) {
    throw new Error("OpenCode debug config did not include the expanded plugin stdio MCP server");
  }
  if (JSON.stringify(remote) !== JSON.stringify({
    type: "remote",
    url: "https://example.com/${DEPLOYMENT}/mcp",
    headers: { "X-Fixture": "Bearer ${TOKEN}" },
  })) {
    throw new Error("OpenCode debug config did not include the plugin HTTP MCP server");
  }
}

function prepareClientHarness(agent) {
  rmSync(projectDir, { recursive: true, force: true });
  cpSync(exampleRoot, projectDir, { recursive: true });
  const configPath = join(projectDir, "agents.toml");
  const config = readFileSync(configPath, "utf-8").replace(/^agents = .*$/m, `agents = ["${agent}"]`);
  writeFileSync(configPath, config);
  runCli(["install"]);
  assertFile(".agents/plugins/qa-tools/plugin.json");
}

async function runCodexRuntimeProof() {
  await installAndAssert();
  proveCodexRuntime();
}

async function installAndAssert() {
  runCli(["install"]);
  const list = runCli(["list"]);
  writeFileSync(join(tmp, "list.out"), list);
  const listStatuses = await listSkills();
  assertSkillStatus(listStatuses, "review");
  assertSkillStatus(listStatuses, "commit");
  runCli(["doctor", "--fix"]);
  runCli(["doctor"]);

  assertFile(".agents/skills/review/SKILL.md");
  assertFile(".agents/skills/commit/SKILL.md");
  assertFileIncludes(".agents/skills/review/SKILL.md", "name: review");
  assertFileIncludes(".agents/skills/review/SKILL.md", "Review fixture.");
  assertFileIncludes(".agents/skills/commit/SKILL.md", "name: commit");
  assertFileIncludes(".agents/skills/commit/SKILL.md", "Commit fixture.");
  assertSymlink(".claude/skills");
  assertFile(".mcp.json");
  assertFile(".cursor/mcp.json");
  assertFile(".codex/config.toml");
  assertFile(".opencode/opencode.jsonc");
  assertFile(".claude/settings.json");
  assertFile(".cursor/hooks.json");
  assertSubagentOutputs();
  assertPluginOutputs();
}

function runCli(cliArgs) {
  return execFileSync("node", [cliPath, ...cliArgs], {
    cwd: projectDir,
    env: fixtureEnv,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "inherit"],
  });
}

function commandAvailable(command) {
  try {
    execFileSync("sh", ["-lc", `command -v ${command}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function execJson(command, args, env) {
  const output = execFileSync(command, args, {
    cwd: projectDir,
    env,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  return JSON.parse(output);
}

async function listSkills() {
  const [{ runList }, { resolveScope }] = await Promise.all([
    import(pathToFileURL(join(repoRoot, "packages", "dotagents", "dist", "cli", "commands", "list.js")).href),
    import(pathToFileURL(join(repoRoot, "packages", "dotagents", "dist", "scope.js")).href),
  ]);
  return runList({ scope: resolveScope("project", projectDir) });
}

function proveCodexRuntime() {
  if (!existsSync(join(projectDir, ".git"))) {
    execFileSync("git", ["init"], {
      cwd: projectDir,
      stdio: ["ignore", "ignore", "inherit"],
    });
  }

  const realProjectDir = realpathSync(projectDir);
  const sourceCodexHome = process.env.CODEX_HOME ?? join(process.env.HOME ?? "", ".codex");
  const sourceAuth = join(sourceCodexHome, "auth.json");
  const sourceConfig = join(sourceCodexHome, "config.toml");
  if (!existsSync(sourceAuth)) {
    throw new Error(`Codex runtime QA requires auth.json at ${sourceAuth}`);
  }

  mkdirSync(codexHomeDir, { recursive: true });
  cpSync(sourceAuth, join(codexHomeDir, "auth.json"));
  const config = existsSync(sourceConfig) ? readFileSync(sourceConfig, "utf-8") : "";
  writeFileSync(
    join(codexHomeDir, "config.toml"),
    `${config.trimEnd()}\n\n[projects.${JSON.stringify(realProjectDir)}]\ntrust_level = "trusted"\n`,
  );

  const outputPath = join(tmp, "codex-runtime.jsonl");
  const lastMessagePath = join(tmp, "codex-runtime.out");
  const stderrPath = join(tmp, "codex-runtime.stderr");
  const prompt = [
    "Spawn the custom agent named code-reviewer, wait for it, and return only its exact response.",
    "Return only the subagent's exact response.",
    "Do not inspect files or answer from project files yourself.",
  ].join(" ");
  let output;
  try {
    output = execFileSync(
      "codex",
      [
        "exec",
        "--json",
        "-C",
        realProjectDir,
        "--output-last-message",
        lastMessagePath,
        prompt,
      ],
      {
        cwd: realProjectDir,
        env: { ...process.env, CODEX_HOME: codexHomeDir },
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch (err) {
    if (err && typeof err === "object" && "stdout" in err && typeof err.stdout === "string") {
      writeFileSync(outputPath, err.stdout);
    }
    if (err && typeof err === "object" && "stderr" in err && typeof err.stderr === "string") {
      writeFileSync(stderrPath, err.stderr);
    }
    throw err;
  }
  writeFileSync(outputPath, output);
  const lastMessage = readFileSync(lastMessagePath, "utf-8");
  assertIncludes(lastMessage, sentinel, "Codex runtime final message should include the subagent sentinel");
  assertCodexRuntimeEvents(output);
}

function assertSubagentOutputs() {
  assertFile(".agents/agents/code-reviewer.md");
  assertFile(".claude/agents/code-reviewer.md");
  assertFile(".cursor/agents/code-reviewer.md");
  assertFile(".codex/agents/code-reviewer.toml");
  assertFile(".opencode/agents/code-reviewer.md");
  assertFileIncludes("agents.lock", "code-reviewer");
  assertFileIncludes(".claude/agents/code-reviewer.md", "Generated by dotagents");
  assertFileIncludes(".claude/agents/code-reviewer.md", "name: \"code-reviewer\"");
  assertFileIncludes(".claude/agents/code-reviewer.md", "A proof-only reviewer.");
  assertFileIncludes(".claude/agents/code-reviewer.md", sentinel);
  assertFileIncludes(".cursor/agents/code-reviewer.md", "Generated by dotagents");
  assertFileIncludes(".cursor/agents/code-reviewer.md", "name: \"code-reviewer\"");
  assertFileIncludes(".cursor/agents/code-reviewer.md", "A proof-only reviewer.");
  assertFileIncludes(".cursor/agents/code-reviewer.md", sentinel);
  assertFileIncludes(".codex/agents/code-reviewer.toml", "Generated by dotagents");
  assertFileIncludes(".codex/agents/code-reviewer.toml", 'name = "code-reviewer"');
  assertFileIncludes(".codex/agents/code-reviewer.toml", 'description = "A proof-only reviewer.');
  assertFileIncludes(".codex/agents/code-reviewer.toml", "developer_instructions = ");
  assertFileIncludes(".codex/agents/code-reviewer.toml", sentinel);
  assertFileIncludes(".opencode/agents/code-reviewer.md", "Generated by dotagents");
  assertFileIncludes(".opencode/agents/code-reviewer.md", "A proof-only reviewer.");
  assertFileIncludes(".opencode/agents/code-reviewer.md", sentinel);
}

function assertPluginOutputs() {
  assertFile(".agents/plugins/qa-tools/plugin.json");
  assertFileIncludes(".agents/plugins/qa-tools/plugin.json", '"$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"');
  assertFile(".agents/plugins/qa-tools/mcp.json");
  assertFileIncludes(".agents/plugins/qa-tools/mcp.json", '"fixture-stdio"');
  assertFileIncludes(".agents/plugins/qa-tools/mcp.json", '"fixture-http"');
  assertFile(".agents/plugins/qa-tools/server.mjs");
  assertFile(".agents/plugins/qa-tools/skills/plugin-qa/SKILL.md");
  assertFile(".agents/plugins/qa-tools/com.example.client/commands/plugin-qa.md");
  assertFile(".agents/plugins/qa-tools/com.example.client/agents/plugin-reviewer.md");
  assertFile(".agents/plugins/qa-tools/.claude-plugin/plugin.json");
  assertSymlink(".agents/skills/plugin-qa");
  assertFile(".agents/skills/.dotagents-managed/plugin-qa");
  assertFileIncludes(".agents/.gitignore", "/skills/plugin-qa");
  assertFileIncludes(".agents/.gitignore", "/skills/.dotagents-managed/");
  assertFileIncludes("agents.lock", "qa-tools");
  assertFile(".agents/plugins/marketplace.json");
  assertFile(".agents/plugins/marketplace.json.dotagents-managed");
  assertFileIncludes(".agents/plugins/marketplace.json", '"name": "dotagents-local"');
  assertFileExcludes(".agents/plugins/marketplace.json", '"managedBy"');
  assertFileIncludes(".agents/plugins/marketplace.json", '"path": "./.agents/plugins/qa-tools"');
  assertFileIncludes(".agents/plugins/marketplace.json", '"installation": "AVAILABLE"');
  assertFileIncludes(".agents/plugins/marketplace.json", '"authentication": "ON_INSTALL"');
  assertFileIncludes(".agents/plugins/marketplace.json", '"source": "local"');

  assertFile(".claude-plugin/marketplace.json");
  assertFile(".claude-plugin/marketplace.json.dotagents-managed");
  assertFileIncludes(".claude-plugin/marketplace.json", '"description": "Generated by dotagents"');
  assertFileExcludes(".claude-plugin/marketplace.json", '"managedBy"');
  assertFileIncludes(".claude-plugin/marketplace.json", '"name": "qa-tools"');
  assertFileIncludes(".claude-plugin/marketplace.json", '"source": "./.agents/plugins/qa-tools"');
  assertFile(".cursor-plugin/marketplace.json");
  assertFile(".cursor-plugin/marketplace.json.dotagents-managed");
  assertSameFile(".cursor-plugin/marketplace.json", ".claude-plugin/marketplace.json");

  assertFile(".agents/plugins/qa-tools/.claude-plugin/plugin.json.dotagents-managed");
  assertFileExcludes(".agents/plugins/qa-tools/.claude-plugin/plugin.json", '"managedBy"');
  assertFileIncludes(".agents/plugins/qa-tools/.claude-plugin/plugin.json", '"skills": "./skills"');
  assertFileIncludes(".agents/plugins/qa-tools/.claude-plugin/plugin.json", '"mcpServers": "./mcp.json"');
  assertFileExcludes(".agents/plugins/qa-tools/.claude-plugin/plugin.json", '"commands"');
  assertFile(".agents/plugins/qa-tools/.cursor-plugin/plugin.json");
  assertFile(".agents/plugins/qa-tools/.cursor-plugin/plugin.json.dotagents-managed");
  assertFileExcludes(".agents/plugins/qa-tools/.cursor-plugin/plugin.json", '"managedBy"');
  assertFileIncludes(".agents/plugins/qa-tools/.cursor-plugin/plugin.json", '"skills": "./skills"');
  assertFileIncludes(".agents/plugins/qa-tools/.cursor-plugin/plugin.json", '"mcpServers": "./mcp.json"');
  assertFileExcludes(".agents/plugins/qa-tools/.cursor-plugin/plugin.json", '"commands"');
  assertFileExcludes(".agents/plugins/qa-tools/.cursor-plugin/plugin.json", '"agents"');
  assertFile(".agents/plugins/qa-tools/.codex-plugin/plugin.json");
  assertFile(".agents/plugins/qa-tools/.codex-plugin/plugin.json.dotagents-managed");
  assertFileExcludes(".agents/plugins/qa-tools/.codex-plugin/plugin.json", '"managedBy"');
  assertFileIncludes(".agents/plugins/qa-tools/.codex-plugin/plugin.json", '"skills": "./skills"');
  assertFileIncludes(".agents/plugins/qa-tools/.codex-plugin/plugin.json", '"mcpServers": "./mcp.json"');
  assertFileExcludes(".agents/plugins/qa-tools/.codex-plugin/plugin.json", '"commands"');
  assertFileExcludes(".agents/plugins/qa-tools/.codex-plugin/plugin.json", '"agents"');

  assertFile(".grok/plugins/qa-tools/.dotagents-managed");
  assertFile(".grok/plugins/qa-tools/plugin.json");
  assertFile(".grok/plugins/qa-tools/server.mjs");
  assertFile(".grok/plugins/qa-tools/com.example.client/commands/plugin-qa.md");
  assertFile(".grok/plugins/qa-tools/com.example.client/agents/plugin-reviewer.md");
  assertFileIncludes(".grok/plugins/qa-tools/skills/plugin-qa/SKILL.md", "DOTAGENTS_PLUGIN_QA_FIXTURE");

  assertSymlink(".opencode/skills/plugin-qa");
  assertFile(".opencode/skills/.dotagents-managed/plugin-qa");
  assertMissing(".opencode/agents/plugin-reviewer.md");
}

function assertFile(relativePath) {
  const path = join(projectDir, relativePath);
  if (!existsSync(path)) {
    throw new Error(`expected file to exist: ${relativePath}`);
  }
}

function assertFileDoesNotExist(relativePath) {
  const path = join(projectDir, relativePath);
  if (existsSync(path)) {
    throw new Error(`expected file not to exist: ${relativePath}`);
  }
}

function assertSymlink(relativePath) {
  const path = join(projectDir, relativePath);
  if (!existsSync(path) || !lstatSync(path).isSymbolicLink()) {
    throw new Error(`expected symlink to exist: ${relativePath}`);
  }
}

function assertFileIncludes(relativePath, expected) {
  assertFile(relativePath);
  assertIncludes(readFileSync(join(projectDir, relativePath), "utf-8"), expected, `${relativePath} should include ${expected}`);
}

function assertFileExcludes(relativePath, unexpected) {
  assertFile(relativePath);
  const content = readFileSync(join(projectDir, relativePath), "utf-8");
  if (content.includes(unexpected)) {
    throw new Error(`${relativePath} should not include ${unexpected}`);
  }
}

function assertMissing(relativePath) {
  if (existsSync(join(projectDir, relativePath))) {
    throw new Error(`expected path to be absent: ${relativePath}`);
  }
}

function assertSkillStatus(statuses, name) {
  const status = statuses.find((entry) => entry.name === name);
  if (!status) {
    throw new Error(`list should include ${name}`);
  }
  if (status.status !== "ok") {
    throw new Error(`list should report ${name} as ok, got ${status.status}`);
  }
}

function assertSameFile(actualPath, expectedPath) {
  assertFile(actualPath);
  assertFile(expectedPath);
  const actual = readFileSync(join(projectDir, actualPath), "utf-8");
  const expected = readFileSync(join(projectDir, expectedPath), "utf-8");
  if (actual !== expected) {
    throw new Error(`${actualPath} should match ${expectedPath}`);
  }
}

function assertIncludes(value, expected, message) {
  if (!value.includes(expected)) {
    throw new Error(message);
  }
}

function assertCodexRuntimeEvents(output) {
  assertIncludes(output, '"tool":"spawn_agent"', "Codex runtime JSONL should include a spawn_agent event");
  assertIncludes(output, '"tool":"wait"', "Codex runtime JSONL should include a wait event");
  if (output.includes("unknown agent_type")) {
    throw new Error("Codex runtime JSONL reported an unknown custom agent type");
  }

  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) {continue;}
    const event = JSON.parse(line);
    const states = event.item?.agents_states;
    if (!states || typeof states !== "object") {continue;}
    for (const state of Object.values(states)) {
      if (state?.message?.includes(sentinel)) {
        return;
      }
    }
  }

  throw new Error("Codex runtime JSONL should include a waited child-agent response with the sentinel");
}
