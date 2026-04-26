import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runMcpAdd, runMcpRemove, getMcpList, McpError, validateMcpName, parseHeader } from "./mcp.js";
import { loadConfig } from "../../config/loader.js";
import type { ScopeRoot } from "../../scope.js";

describe("mcp", () => {
  let tmpDir: string;
  let stateDir: string;
  let projectRoot: string;
  let scope: ScopeRoot;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dotagents-mcp-"));
    stateDir = join(tmpDir, "state");
    projectRoot = join(tmpDir, "project");

    process.env["DOTAGENTS_STATE_DIR"] = stateDir;

    await mkdir(join(projectRoot, ".agents", "skills"), { recursive: true });
    await writeFile(join(projectRoot, "agents.toml"), "version = 1\n");

    scope = {
      scope: "project",
      root: projectRoot,
      agentsDir: join(projectRoot, ".agents"),
      skillsDir: join(projectRoot, ".agents", "skills"),
      configPath: join(projectRoot, "agents.toml"),
      lockPath: join(projectRoot, "agents.lock"),
    };
  });

  afterEach(async () => {
    delete process.env["DOTAGENTS_STATE_DIR"];
    await rm(tmpDir, { recursive: true });
  });

  describe("validateMcpName", () => {
    it("accepts valid names", () => {
      expect(() => validateMcpName("github")).not.toThrow();
      expect(() => validateMcpName("my-server")).not.toThrow();
      expect(() => validateMcpName("server.v2")).not.toThrow();
      expect(() => validateMcpName("MCP_Server")).not.toThrow();
    });

    it("rejects invalid names", () => {
      expect(() => validateMcpName("")).toThrow(McpError);
      expect(() => validateMcpName("-bad")).toThrow(McpError);
      expect(() => validateMcpName(".bad")).toThrow(McpError);
      expect(() => validateMcpName("has space")).toThrow(McpError);
    });
  });

  describe("parseHeader", () => {
    it("splits on first colon", () => {
      expect(parseHeader("Authorization:Bearer tok")).toEqual(["Authorization", "Bearer tok"]);
    });

    it("handles colons in value", () => {
      expect(parseHeader("X-Key:val:ue")).toEqual(["X-Key", "val:ue"]);
    });

    it("throws on malformed header", () => {
      expect(() => parseHeader("no-colon")).toThrow(McpError);
      expect(() => parseHeader(":no-key")).toThrow(McpError);
    });
  });

  describe("runMcpAdd", () => {
    it("adds a stdio server", async () => {
      await runMcpAdd({
        scope,
        name: "github",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
        env: ["GITHUB_TOKEN"],
      });

      const config = await loadConfig(scope.configPath);
      expect(config.mcp).toHaveLength(1);
      expect(config.mcp[0]!.name).toBe("github");
      expect(config.mcp[0]!.command).toBe("npx");
      expect(config.mcp[0]!.args).toEqual(["-y", "@modelcontextprotocol/server-github"]);
      expect(config.mcp[0]!.env).toEqual(["GITHUB_TOKEN"]);
    });

    it("adds an http server", async () => {
      await runMcpAdd({
        scope,
        name: "remote",
        url: "https://mcp.example.com/sse",
        headers: ["Authorization:Bearer tok"],
        env: ["API_KEY"],
      });

      const config = await loadConfig(scope.configPath);
      expect(config.mcp).toHaveLength(1);
      expect(config.mcp[0]!.url).toBe("https://mcp.example.com/sse");
      expect(config.mcp[0]!.headers).toEqual({ Authorization: "Bearer tok" });
    });

    it("rejects duplicate name", async () => {
      await runMcpAdd({ scope, name: "github", command: "npx" });
      await expect(
        runMcpAdd({ scope, name: "github", command: "other" }),
      ).rejects.toThrow(/already exists/);
    });

    it("rejects both --command and --url", async () => {
      await expect(
        runMcpAdd({ scope, name: "bad", command: "npx", url: "https://example.com" }),
      ).rejects.toThrow(/Cannot specify both/);
    });

    it("rejects neither --command nor --url", async () => {
      await expect(
        runMcpAdd({ scope, name: "bad" }),
      ).rejects.toThrow(/Must specify either/);
    });

    it("rejects invalid name", async () => {
      await expect(
        runMcpAdd({ scope, name: "-bad", command: "npx" }),
      ).rejects.toThrow(McpError);
    });
  });

  describe("runMcpRemove", () => {
    it("removes an existing server", async () => {
      await runMcpAdd({ scope, name: "github", command: "npx" });
      await runMcpRemove({ scope, name: "github" });

      const config = await loadConfig(scope.configPath);
      expect(config.mcp).toHaveLength(0);
    });

    it("throws for non-existent server", async () => {
      await expect(
        runMcpRemove({ scope, name: "nope" }),
      ).rejects.toThrow(/not found/);
    });

    it("preserves other servers", async () => {
      await runMcpAdd({ scope, name: "a", command: "cmd-a" });
      await runMcpAdd({ scope, name: "b", command: "cmd-b" });
      await runMcpRemove({ scope, name: "a" });

      const config = await loadConfig(scope.configPath);
      expect(config.mcp).toHaveLength(1);
      expect(config.mcp[0]!.name).toBe("b");
    });
  });

  describe("getMcpList", () => {
    it("returns empty for no servers", async () => {
      const config = await loadConfig(scope.configPath);
      expect(getMcpList(config)).toEqual([]);
    });

    it("returns stdio entries", async () => {
      await runMcpAdd({ scope, name: "github", command: "npx", env: ["TOKEN"] });
      const config = await loadConfig(scope.configPath);
      const list = getMcpList(config);
      expect(list).toHaveLength(1);
      expect(list[0]).toEqual({
        name: "github",
        transport: "stdio",
        target: "npx",
        env: ["TOKEN"],
      });
    });

    it("returns http entries", async () => {
      await runMcpAdd({ scope, name: "remote", url: "https://example.com/mcp" });
      const config = await loadConfig(scope.configPath);
      const list = getMcpList(config);
      expect(list).toHaveLength(1);
      expect(list[0]).toEqual({
        name: "remote",
        transport: "http",
        target: "https://example.com/mcp",
        env: [],
      });
    });
  });
});
