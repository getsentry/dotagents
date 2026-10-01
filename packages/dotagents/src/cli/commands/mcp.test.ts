import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import mcp, { runMcpAdd, runMcpRemove, getMcpList, McpError, validateMcpName, parseHeader } from "./mcp.js";
import { loadConfig } from "../../config/loader.js";
import { resolveScope, type ScopeRoot } from "../../scope.js";
import { runSync } from "./sync.js";
import { runInstall } from "./install.js";

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
      pluginsDir: join(projectRoot, ".agents", "plugins"),
      configPath: join(projectRoot, "agents.toml"),
      lockPath: join(projectRoot, "agents.lock"),
    };
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    process.exitCode = undefined;
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
    it.each(["project", "user"] as const)("installs and repairs Pi MCP in %s scope while preserving unrelated settings", async (kind) => {
      const piHome = join(tmpDir, "pi-home");
      vi.stubEnv("PI_CODING_AGENT_DIR", piHome);
      vi.stubEnv("DOTAGENTS_HOME", join(tmpDir, "global"));
      const targetScope = resolveScope(kind, projectRoot);
      await mkdir(targetScope.root, { recursive: true });
      await writeFile(targetScope.configPath, 'version = 1\nagents = ["pi"]\n');
      const targetDir = kind === "project" ? join(projectRoot, ".pi") : piHome;
      await mkdir(targetDir, { recursive: true });
      const targetPath = join(targetDir, "mcp.json");
      const manual = { command: "manual-server", exposure: "direct", enabled: false };
      await writeFile(targetPath, JSON.stringify({ autoEnableCodemode: false, mcpServers: { manual } }));

      await runMcpAdd({ scope: targetScope, name: "local-tools", command: "node", args: ["server.mjs"], env: ["TOOLS_TOKEN"] });
      await runMcpAdd({ scope: targetScope, name: "remote_tools", url: "https://example.com/mcp", headers: ["Authorization:Bearer ${API_TOKEN}"] });
      const expected = {
        autoEnableCodemode: false,
        mcpServers: {
          manual,
          "local-tools": { command: "node", args: ["server.mjs"], env: { TOOLS_TOKEN: "${TOOLS_TOKEN}" } },
          remote_tools: { type: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer ${API_TOKEN}" } },
        },
      };
      expect(JSON.parse(await readFile(targetPath, "utf-8"))).toEqual(expected);
      const installed = await readFile(targetPath, "utf-8");
      await runInstall({ scope: targetScope });
      expect(await readFile(targetPath, "utf-8")).toBe(installed);

      await writeFile(targetPath, JSON.stringify({ autoEnableCodemode: false, mcpServers: { manual } }));
      expect((await runSync({ scope: targetScope })).mcpRepaired).toBe(1);
      expect(JSON.parse(await readFile(targetPath, "utf-8"))).toEqual(expected);
      expect((await runSync({ scope: targetScope })).mcpRepaired).toBe(0);

      await rm(targetPath);
      expect((await runSync({ scope: targetScope })).mcpRepaired).toBe(1);
      expect(JSON.parse(await readFile(targetPath, "utf-8"))).toEqual({
        mcpServers: {
          "local-tools": expected.mcpServers["local-tools"],
          remote_tools: expected.mcpServers.remote_tools,
        },
      });
    });

    it.each([
      { name: "server.v2", url: "https://example.com/mcp", error: "Invalid Pi MCP server name" },
      { name: "remote", url: "https://${HOST}/mcp", error: "requires a literal URL" },
    ])("rejects unsupported Pi declarations before saving: $name / $url", async ({ name, url, error }) => {
      const config = 'version = 1\nagents = ["pi"]\n';
      await writeFile(scope.configPath, config);
      await expect(runMcpAdd({ scope, name, url })).rejects.toThrow(error);
      expect(await readFile(scope.configPath, "utf-8")).toBe(config);
    });

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
        url: "https://mcp.example.com/mcp",
        headers: ["Authorization:Bearer tok"],
        env: ["API_KEY"],
      });

      const config = await loadConfig(scope.configPath);
      expect(config.mcp).toHaveLength(1);
      expect(config.mcp[0]!.url).toBe("https://mcp.example.com/mcp");
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

    it("projects stdio and HTTP entries", async () => {
      await runMcpAdd({ scope, name: "github", command: "npx", env: ["TOKEN"] });
      await runMcpAdd({ scope, name: "remote", url: "https://example.com/mcp" });
      const config = await loadConfig(scope.configPath);
      const list = getMcpList(config);
      expect(list).toHaveLength(2);
      expect(list[0]).toEqual({
        name: "github",
        transport: "stdio",
        target: "npx",
        env: ["TOKEN"],
      });
      expect(list[1]).toEqual({
        name: "remote",
        transport: "http",
        target: "https://example.com/mcp",
        env: [],
      });
    });
  });

  it("includes explicit project scope in nested usage errors", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await mcp(["add"], { scope });

    expect(error).toHaveBeenCalledWith(expect.stringContaining("npx @sentry/dotagents --project mcp add"));
    error.mockRestore();
  });
});
