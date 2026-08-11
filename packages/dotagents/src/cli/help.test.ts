import { describe, expect, it } from "vitest";
import { getCommandHelp } from "./help.js";

describe("getCommandHelp", () => {
  it.each([
    "init",
    "install",
    "add",
    "remove",
    "sync",
    "list",
    "doctor",
    "mcp",
    "trust",
  ])("returns help for %s", (command) => {
    expect(getCommandHelp(command, ["--help"])).toContain(` ${command}`);
    expect(getCommandHelp(command, ["-h"])).toContain("Usage:");
  });

  it.each([
    ["mcp", "add"],
    ["mcp", "remove"],
    ["mcp", "list"],
    ["trust", "add"],
    ["trust", "remove"],
    ["trust", "list"],
  ])("returns nested help for %s %s", (command, subcommand) => {
    expect(getCommandHelp(command, [subcommand, "--help"])).toContain(
      ` ${command} ${subcommand}`,
    );
  });

  it("does not intercept normal command arguments", () => {
    expect(getCommandHelp("add", ["getsentry/skills", "find-bugs"])).toBeUndefined();
  });

  it("describes dependency-neutral plugin-first add behavior", () => {
    const help = getCommandHelp("add", ["--help"]);

    expect(help).toContain("add <source> [name...]");
    expect(help).toContain("Discover plugins first, otherwise skills");
    expect(help).toContain("--name <name>");
    expect(help).toContain("Compatibility alias");
    expect(help).toContain("Add plugins explicitly, or all skills as a wildcard");
    expect(help).not.toContain("--plugin");
  });

  it("gives exact scope guidance on command help", () => {
    const help = getCommandHelp("install", ["--help"]);

    expect(help).toContain(`Scope:
  (no flag)  Global scope (~/.agents/); this is the default
  --project  Current project (Git root, or current directory outside Git)
  --global   Explicit global scope
  --user     Compatibility alias for --global`);
  });
});
