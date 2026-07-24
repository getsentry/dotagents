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
});
