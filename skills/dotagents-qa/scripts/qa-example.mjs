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
  runCli(["sync"]);
  assertFile(".mcp.json");
  assertSymlink(".claude/skills");
  assertFile(".claude/agents/code-reviewer.md");
  assertFile(".codex/agents/code-reviewer.toml");
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
  assertFile("opencode.json");
  assertFile(".claude/settings.json");
  assertFile(".cursor/hooks.json");
  assertSubagentOutputs();
}

function runCli(cliArgs) {
  return execFileSync("node", [cliPath, ...cliArgs], {
    cwd: projectDir,
    env: fixtureEnv,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "inherit"],
  });
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

function assertFile(relativePath) {
  const path = join(projectDir, relativePath);
  if (!existsSync(path)) {
    throw new Error(`expected file to exist: ${relativePath}`);
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

function assertSkillStatus(statuses, name) {
  const status = statuses.find((entry) => entry.name === name);
  if (!status) {
    throw new Error(`list should include ${name}`);
  }
  if (status.status !== "ok") {
    throw new Error(`list should report ${name} as ok, got ${status.status}`);
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
