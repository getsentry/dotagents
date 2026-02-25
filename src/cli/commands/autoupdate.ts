import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { execSync } from "node:child_process";
import { join, resolve } from "node:path";
import chalk from "chalk";
import { resolveScope } from "../../scope.js";
import { loadConfig } from "../../config/loader.js";
import { setConfigValue } from "../../config/writer.js";
import { ensureRootGitignoreEntry } from "../../gitignore/root.js";
import { findGitDir, bootstrapPostMergeHook } from "../../hooks/git-hooks.js";
import type { ScopeRoot } from "../../scope.js";

interface ChangeItem {
  label: string;
  status: string;
  apply: () => Promise<void>;
  skip: boolean;
}

async function buildChanges(scope: ScopeRoot): Promise<ChangeItem[]> {
  const config = await loadConfig(scope.configPath);
  const changes: ChangeItem[] = [];

  // 1. gitignore = true
  changes.push({
    label: "Set gitignore = true in agents.toml",
    status: config.gitignore ? "(already set)" : `(currently: ${config.gitignore})`,
    skip: config.gitignore,
    apply: () => setConfigValue(scope.configPath, "gitignore", true),
  });

  // 2. pin = false
  changes.push({
    label: "Set pin = false in agents.toml",
    status: !config.pin ? "(already set)" : `(currently: ${config.pin})`,
    skip: !config.pin,
    apply: () => setConfigValue(scope.configPath, "pin", false),
  });

  // 3. Root .gitignore entry
  let rootGitignoreNeeded = true;
  const gitignorePath = join(scope.root, ".gitignore");
  if (existsSync(gitignorePath)) {
    const content = await readFile(gitignorePath, "utf-8");
    rootGitignoreNeeded = !content.split("\n").map((l) => l.trim()).includes(".agents/.gitignore");
  }

  changes.push({
    label: "Add .agents/.gitignore to .gitignore",
    status: rootGitignoreNeeded ? "(not yet present)" : "(already present)",
    skip: !rootGitignoreNeeded,
    apply: async () => { await ensureRootGitignoreEntry(scope.root); },
  });

  // 4. Post-merge hook
  let hookNeeded = true;
  const gitDir = findGitDir(scope.root);
  if (gitDir) {
    const hookPath = join(gitDir, "hooks", "post-merge");
    if (existsSync(hookPath)) {
      const content = await readFile(hookPath, "utf-8");
      hookNeeded = !content.includes("dotagents");
    }
  }

  changes.push({
    label: "Create .git/hooks/post-merge hook",
    status: hookNeeded ? "(not yet present)" : "(already present)",
    skip: !hookNeeded,
    apply: async () => { await bootstrapPostMergeHook(scope.root); },
  });

  // 5. Untrack .agents/.gitignore if it's committed
  let isTracked = false;
  try {
    const result = execSync("git ls-files .agents/.gitignore", {
      cwd: scope.root,
      encoding: "utf-8",
    }).trim();
    isTracked = result.length > 0;
  } catch {
    // git not available — skip
  }

  changes.push({
    label: "Untrack .agents/.gitignore from git",
    status: isTracked ? "(currently tracked)" : "(not tracked)",
    skip: !isTracked,
    apply: async () => {
      execSync("git rm --cached .agents/.gitignore", { cwd: scope.root });
    },
  });

  return changes;
}

export default async function autoupdate(
  _args: string[],
  flags?: { user?: boolean },
): Promise<void> {
  if (flags?.user) {
    console.error(chalk.red("autoupdate is only available for project scope."));
    process.exitCode = 1;
    return;
  }

  const scope = resolveScope("project", resolve("."));

  if (!existsSync(scope.configPath)) {
    console.error(chalk.red("No agents.toml found. Run 'dotagents init' first."));
    process.exitCode = 1;
    return;
  }

  const clack = await import("@clack/prompts");

  const changes = await buildChanges(scope);
  const pending = changes.filter((c) => !c.skip);

  clack.intro(chalk.bold("dotagents autoupdate"));

  if (pending.length === 0) {
    clack.outro("Everything is already configured for auto-updating skills.");
    return;
  }

  const summary = changes
    .map((c) => {
      const bullet = c.skip ? chalk.dim("  - " + c.label) : "  - " + c.label;
      const status = c.skip ? chalk.dim(c.status) : chalk.yellow(c.status);
      return `${bullet}  ${status}`;
    })
    .join("\n");

  clack.note(
    summary +
      "\n\n" +
      "With autoupdate, managed skills are locally generated (not committed).\n" +
      "A post-merge hook runs 'dotagents install' after every pull.",
    "This will configure your project for auto-updating skills:",
  );

  const confirmed = await clack.confirm({
    message: "Apply these changes?",
  });

  if (clack.isCancel(confirmed) || !confirmed) {
    clack.outro("Setup cancelled.");
    return;
  }

  for (const change of pending) {
    await change.apply();
    clack.log.success(change.label);
  }

  clack.outro("Run `dotagents install` to regenerate .agents/.gitignore.");
}
