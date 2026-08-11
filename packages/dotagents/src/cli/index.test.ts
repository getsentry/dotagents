import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const init = vi.fn();
const install = vi.fn();
const add = vi.fn();
const remove = vi.fn();
const sync = vi.fn();
const list = vi.fn();
const mcp = vi.fn();
const trust = vi.fn();
const doctor = vi.fn();
const checkForUpdate = vi.fn(() => Promise.resolve(null));

vi.mock("./commands/init.js", () => ({ default: init }));
vi.mock("./commands/install.js", () => ({ default: install }));
vi.mock("./commands/add.js", () => ({ default: add }));
vi.mock("./commands/remove.js", () => ({ default: remove }));
vi.mock("./commands/sync.js", () => ({ default: sync }));
vi.mock("./commands/list.js", () => ({ default: list }));
vi.mock("./commands/mcp.js", () => ({ default: mcp }));
vi.mock("./commands/trust.js", () => ({ default: trust }));
vi.mock("./commands/doctor.js", () => ({ default: doctor }));
vi.mock("./update-notifier.js", () => ({ checkForUpdate }));

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
    for (const [, handler] of COMMAND_CASES) {handler.mockReset();}
    checkForUpdate.mockClear();
    process.exitCode = originalExitCode;
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
  });

  it("prints command help without running the command", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { main } = await import("./main.js");

    await main(["sync", "--help"]);

    expect(sync).not.toHaveBeenCalled();
    expect(checkForUpdate).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Reconcile local state"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("(no flag)  Global scope (~/.agents/); this is the default"));
    log.mockRestore();
  });

  it("defaults to global scope", async () => {
    const { main } = await import("./main.js");

    await main(["sync"]);

    expect(sync).toHaveBeenCalledWith([], {
      scope: expect.objectContaining({ scope: "user" }),
    });
  });

  it.each(["--user", "--global"])("passes %s as explicit global scope", async (scopeFlag) => {
    const { main } = await import("./main.js");

    await main(["sync", scopeFlag]);

    expect(sync).toHaveBeenCalledWith([], {
      scope: expect.objectContaining({ scope: "user" }),
    });
  });

  it("accepts both user scope aliases together", async () => {
    const { main } = await import("./main.js");

    await main(["--user", "--global", "sync"]);

    expect(sync).toHaveBeenCalledWith([], {
      scope: expect.objectContaining({ scope: "user" }),
    });
  });

  it.each([
    ["before", ["--project", "sync"]],
    ["after", ["sync", "--project"]],
  ])("passes project scope with the flag %s the command", async (_placement, argv) => {
    const { main } = await import("./main.js");

    await main(argv);

    expect(sync).toHaveBeenCalledWith([], {
      scope: expect.objectContaining({ scope: "project" }),
    });
  });

  it("rejects contradictory scope flags without running the command", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { main } = await import("./main.js");

    await main(["--project", "sync", "--global"]);

    expect(sync).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("Cannot combine --project"));
    error.mockRestore();
  });

  it("rejects a project conflict with the legacy alias", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { main } = await import("./main.js");

    await main(["sync", "--project", "--user"]);

    expect(sync).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(error).toHaveBeenCalledWith("Cannot combine --project with --global or --user.");
    error.mockRestore();
  });

  it("documents the default and compatibility flags in top-level help", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { main } = await import("./main.js");

    await main([]);

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
    for (const [, handler] of COMMAND_CASES) {handler.mockReset();}
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
    const { main } = await import("./main.js");

    await main([command]);

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith([], {
      scope: expect.objectContaining({ scope: "user", root: globalRoot }),
    });
  });

  it.each(COMMAND_CASES)("uses only project state for explicit-project %s", async (command, handler) => {
    const { main } = await import("./main.js");

    await main(["--project", command]);

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith([], {
      scope: expect.objectContaining({ scope: "project", root: canonicalProjectRoot }),
    });
  });

  it("fails a project command with no config instead of falling back globally", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await rm(join(projectRoot, "agents.toml"));
    const { main } = await import("./main.js");

    await main(["--project", "sync"]);

    expect(sync).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("--project init"));
    error.mockRestore();
  });

  it("allows project init in the current directory outside Git", async () => {
    await rm(join(projectRoot, ".git"), { recursive: true });
    await rm(join(projectRoot, "agents.toml"));
    const { main } = await import("./main.js");

    await main(["--project", "init"]);

    expect(init).toHaveBeenCalledWith([], {
      scope: expect.objectContaining({ scope: "project", root: canonicalProjectRoot }),
    });
  });
});
