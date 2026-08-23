import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProjectScope, resolveScope } from "../scope.js";
import { main, type CliServices, type CommandHandler } from "./main.js";

const init = vi.fn<CommandHandler>(async () => {});
const install = vi.fn<CommandHandler>(async () => {});
const add = vi.fn<CommandHandler>(async () => {});
const remove = vi.fn<CommandHandler>(async () => {});
const sync = vi.fn<CommandHandler>(async () => {});
const list = vi.fn<CommandHandler>(async () => {});
const mcp = vi.fn<CommandHandler>(async () => {});
const trust = vi.fn<CommandHandler>(async () => {});
const doctor = vi.fn<CommandHandler>(async () => {});
const checkForUpdate = vi.fn(() => Promise.resolve(null));

const services = {
  commands: { init, install, add, remove, sync, list, mcp, trust, doctor },
  checkForUpdate,
  resolveProjectScope: (projectRoot: string) => resolveScope("project", projectRoot),
  resolveScope,
} satisfies CliServices;

const scopeServices = {
  ...services,
  resolveProjectScope,
} satisfies CliServices;

function runMain(argv: string[], cliServices: CliServices = services): Promise<void> {
  return main(argv, cliServices);
}

const COMMAND_CASES = [
  ["init", init],
  ["install", install],
  ["add", add],
  ["remove", remove],
  ["sync", sync],
  ["list", list],
  ["mcp", mcp],
  ["trust", trust],
  ["doctor", doctor],
] as const;

describe("CLI help dispatch", () => {
  const originalExitCode = process.exitCode;

  beforeEach(() => {
    for (const [, handler] of COMMAND_CASES) {
      handler.mockReset();
    }
    checkForUpdate.mockClear();
    process.exitCode = originalExitCode;
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
  });

  it("prints command help without running the command", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await runMain(["sync", "--help"]);

    expect(sync).not.toHaveBeenCalled();
    expect(checkForUpdate).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Reconcile local state"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("(no flag)  Global scope (~/.agents/); this is the default"));
    log.mockRestore();
  });

  it("defaults to global scope", async () => {
    await runMain(["sync"]);

    expect(sync).toHaveBeenCalledWith([], {
      scope: expect.objectContaining({ scope: "user" }),
    });
  });

  it.each(["--user", "--global"])("passes %s as explicit global scope", async (scopeFlag) => {
    await runMain(["sync", scopeFlag]);

    expect(sync).toHaveBeenCalledWith([], {
      scope: expect.objectContaining({ scope: "user" }),
    });
  });

  it("accepts both user scope aliases together", async () => {
    await runMain(["--user", "--global", "sync"]);

    expect(sync).toHaveBeenCalledWith([], {
      scope: expect.objectContaining({ scope: "user" }),
    });
  });

  it.each([
    ["before", ["--project", "sync"]],
    ["after", ["sync", "--project"]],
  ])("passes project scope with the flag %s the command", async (_placement, argv) => {
    await runMain(argv);

    expect(sync).toHaveBeenCalledWith([], {
      scope: expect.objectContaining({ scope: "project" }),
    });
  });

  it("rejects contradictory scope flags without running the command", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await runMain(["--project", "sync", "--global"]);

    expect(sync).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("Cannot combine --project"));
    error.mockRestore();
  });

  it("rejects a project conflict with the legacy alias", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await runMain(["sync", "--project", "--user"]);

    expect(sync).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(error).toHaveBeenCalledWith("Cannot combine --project with --global or --user.");
    error.mockRestore();
  });

  it("documents the default and compatibility flags in top-level help", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await runMain([]);

    expect(log).toHaveBeenCalledWith(expect.stringContaining("--project   Operate on the current project instead of global scope"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("--global    Explicitly operate on global scope (~/.agents/, the default)"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("--user      Compatibility alias for --global"));
    log.mockRestore();
  });
});

describe("scope isolation for all commands", () => {
  let root: string;
  let projectRoot: string;
  let canonicalProjectRoot: string;
  let globalRoot: string;
  let originalCwd: string;

  beforeEach(async () => {
    for (const [, handler] of COMMAND_CASES) {
      handler.mockReset();
    }
    checkForUpdate.mockClear();
    process.exitCode = undefined;
    originalCwd = process.cwd();
    root = await mkdtemp(join(tmpdir(), "dotagents-cli-scope-"));
    projectRoot = join(root, "project");
    globalRoot = join(root, "global");
    await mkdir(join(projectRoot, ".git"), { recursive: true });
    await mkdir(globalRoot, { recursive: true });
    await writeFile(join(projectRoot, "agents.toml"), "version = 1\n");
    await writeFile(join(globalRoot, "agents.toml"), "version = 1\n");
    canonicalProjectRoot = await realpath(projectRoot);
    process.env["DOTAGENTS_HOME"] = globalRoot;
    process.chdir(projectRoot);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    delete process.env["DOTAGENTS_HOME"];
    await rm(root, { recursive: true, force: true });
  });

  it.each(COMMAND_CASES)("uses only global state for unqualified %s", async (command, handler) => {
    await runMain([command], scopeServices);

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith([], {
      scope: expect.objectContaining({ scope: "user", root: globalRoot }),
    });
  });

  it.each(COMMAND_CASES)("uses only project state for explicit-project %s", async (command, handler) => {
    await runMain(["--project", command], scopeServices);

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith([], {
      scope: expect.objectContaining({ scope: "project", root: canonicalProjectRoot }),
    });
  });

  it("fails a project command with no config instead of falling back globally", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await rm(join(projectRoot, "agents.toml"));
    await runMain(["--project", "sync"], scopeServices);

    expect(sync).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("--project init"));
    error.mockRestore();
  });

  it("allows project init in the current directory outside Git", async () => {
    await rm(join(projectRoot, ".git"), { recursive: true });
    await rm(join(projectRoot, "agents.toml"));
    await runMain(["--project", "init"], scopeServices);

    expect(init).toHaveBeenCalledWith([], {
      scope: expect.objectContaining({ scope: "project", root: canonicalProjectRoot }),
    });
  });
});
