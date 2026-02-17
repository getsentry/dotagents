import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { writeMcpConfigs, verifyMcpConfigs, projectMcpResolver } from "./mcp-writer.js";
import type { McpDeclaration } from "./types.js";

const STDIO_SERVER: McpDeclaration = {
  name: "github",
  command: "npx",
  args: ["-y", "@mcp/server-github"],
  env: ["GITHUB_TOKEN"],
};

const HTTP_SERVER: McpDeclaration = {
  name: "remote",
  url: "https://mcp.example.com/sse",
  headers: { Authorization: "Bearer tok" },
};

describe("writeMcpConfigs", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "dotagents-mcp-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true });
  });

  it("skips when no servers declared", async () => {
    await writeMcpConfigs(["claude"], [], projectMcpResolver(dir));
    expect(existsSync(join(dir, ".mcp.json"))).toBe(false);
  });

  it("writes claude .mcp.json", async () => {
    await writeMcpConfigs(["claude"], [STDIO_SERVER], projectMcpResolver(dir));

    const content = JSON.parse(await readFile(join(dir, ".mcp.json"), "utf-8"));
    expect(content.mcpServers.github).toEqual({
      command: "npx",
      args: ["-y", "@mcp/server-github"],
      env: { GITHUB_TOKEN: "${GITHUB_TOKEN}" },
    });
  });

  it("writes cursor .cursor/mcp.json", async () => {
    await writeMcpConfigs(["cursor"], [STDIO_SERVER], projectMcpResolver(dir));

    const content = JSON.parse(await readFile(join(dir, ".cursor", "mcp.json"), "utf-8"));
    expect(content.mcpServers.github).toBeDefined();
  });

  it("writes vscode .vscode/mcp.json with input refs", async () => {
    await writeMcpConfigs(["vscode"], [STDIO_SERVER], projectMcpResolver(dir));

    const content = JSON.parse(await readFile(join(dir, ".vscode", "mcp.json"), "utf-8"));
    expect(content.servers.github).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "@mcp/server-github"],
      env: { GITHUB_TOKEN: "${input:GITHUB_TOKEN}" },
    });
  });

  it("writes codex .codex/config.toml", async () => {
    await writeMcpConfigs(["codex"], [STDIO_SERVER], projectMcpResolver(dir));

    const raw = await readFile(join(dir, ".codex", "config.toml"), "utf-8");
    expect(raw).toContain("mcp_servers");
    expect(raw).toContain("github");
  });

  it("writes opencode.json", async () => {
    await writeMcpConfigs(["opencode"], [STDIO_SERVER], projectMcpResolver(dir));

    const content = JSON.parse(await readFile(join(dir, "opencode.json"), "utf-8"));
    expect(content.mcp.github).toEqual({
      type: "local",
      command: ["npx", "-y", "@mcp/server-github"],
      environment: { GITHUB_TOKEN: "${GITHUB_TOKEN}" },
    });
  });

  it("handles multiple agents", async () => {
    await writeMcpConfigs(["claude", "cursor", "vscode"], [STDIO_SERVER], projectMcpResolver(dir));

    expect(existsSync(join(dir, ".mcp.json"))).toBe(true);
    expect(existsSync(join(dir, ".cursor", "mcp.json"))).toBe(true);
    expect(existsSync(join(dir, ".vscode", "mcp.json"))).toBe(true);
  });

  it("handles multiple servers", async () => {
    await writeMcpConfigs(["claude"], [STDIO_SERVER, HTTP_SERVER], projectMcpResolver(dir));

    const content = JSON.parse(await readFile(join(dir, ".mcp.json"), "utf-8"));
    expect(Object.keys(content.mcpServers)).toHaveLength(2);
    expect(content.mcpServers.github).toBeDefined();
    expect(content.mcpServers.remote).toBeDefined();
  });

  it("writes claude HTTP server with type: http", async () => {
    await writeMcpConfigs(["claude"], [HTTP_SERVER], projectMcpResolver(dir));

    const content = JSON.parse(await readFile(join(dir, ".mcp.json"), "utf-8"));
    expect(content.mcpServers.remote).toEqual({
      type: "http",
      url: "https://mcp.example.com/sse",
      headers: { Authorization: "Bearer tok" },
    });
  });

  it("writes cursor HTTP server with type: http", async () => {
    await writeMcpConfigs(["cursor"], [HTTP_SERVER], projectMcpResolver(dir));

    const content = JSON.parse(await readFile(join(dir, ".cursor", "mcp.json"), "utf-8"));
    expect(content.mcpServers.remote).toEqual({
      type: "http",
      url: "https://mcp.example.com/sse",
      headers: { Authorization: "Bearer tok" },
    });
  });

  it("writes vscode HTTP server with type: http", async () => {
    await writeMcpConfigs(["vscode"], [HTTP_SERVER], projectMcpResolver(dir));

    const content = JSON.parse(await readFile(join(dir, ".vscode", "mcp.json"), "utf-8"));
    expect(content.servers.remote).toEqual({
      type: "http",
      url: "https://mcp.example.com/sse",
      headers: { Authorization: "Bearer tok" },
    });
  });

  it("writes opencode HTTP server with type: remote", async () => {
    await writeMcpConfigs(["opencode"], [HTTP_SERVER], projectMcpResolver(dir));

    const content = JSON.parse(await readFile(join(dir, "opencode.json"), "utf-8"));
    expect(content.mcp.remote).toEqual({
      type: "remote",
      url: "https://mcp.example.com/sse",
      headers: { Authorization: "Bearer tok" },
    });
  });

  it("writes codex HTTP server with http_headers and no type", async () => {
    await writeMcpConfigs(["codex"], [HTTP_SERVER], projectMcpResolver(dir));

    const { parse: parseTOML } = await import("smol-toml");
    const raw = await readFile(join(dir, ".codex", "config.toml"), "utf-8");
    const content = parseTOML(raw) as Record<string, Record<string, Record<string, unknown>>>;
    expect(content["mcp_servers"]!["remote"]).toEqual({
      url: "https://mcp.example.com/sse",
      http_headers: { Authorization: "Bearer tok" },
    });
  });

  it("writes correct HTTP servers for all agents", async () => {
    const allAgents = ["claude", "cursor", "vscode", "opencode", "codex"];
    await writeMcpConfigs(allAgents, [STDIO_SERVER, HTTP_SERVER], projectMcpResolver(dir));

    // Claude
    const claude = JSON.parse(await readFile(join(dir, ".mcp.json"), "utf-8"));
    expect(claude.mcpServers.remote).toEqual({
      type: "http",
      url: "https://mcp.example.com/sse",
      headers: { Authorization: "Bearer tok" },
    });

    // Cursor
    const cursor = JSON.parse(await readFile(join(dir, ".cursor", "mcp.json"), "utf-8"));
    expect(cursor.mcpServers.remote).toEqual({
      type: "http",
      url: "https://mcp.example.com/sse",
      headers: { Authorization: "Bearer tok" },
    });

    // VS Code
    const vscode = JSON.parse(await readFile(join(dir, ".vscode", "mcp.json"), "utf-8"));
    expect(vscode.servers.remote).toEqual({
      type: "http",
      url: "https://mcp.example.com/sse",
      headers: { Authorization: "Bearer tok" },
    });

    // OpenCode
    const opencode = JSON.parse(await readFile(join(dir, "opencode.json"), "utf-8"));
    expect(opencode.mcp.remote).toEqual({
      type: "remote",
      url: "https://mcp.example.com/sse",
      headers: { Authorization: "Bearer tok" },
    });

    // Codex
    const { parse: parseTOML } = await import("smol-toml");
    const raw = await readFile(join(dir, ".codex", "config.toml"), "utf-8");
    const codex = parseTOML(raw) as Record<string, Record<string, Record<string, unknown>>>;
    expect(codex["mcp_servers"]!["remote"]).toEqual({
      url: "https://mcp.example.com/sse",
      http_headers: { Authorization: "Bearer tok" },
    });
  });

  it("merges into existing shared config file", async () => {
    // Codex config.toml is shared — write something else first
    const codexDir = join(dir, ".codex");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(codexDir, { recursive: true });
    await writeFile(join(codexDir, "config.toml"), 'model = "o3"\n', "utf-8");

    await writeMcpConfigs(["codex"], [STDIO_SERVER], projectMcpResolver(dir));

    const raw = await readFile(join(codexDir, "config.toml"), "utf-8");
    // Should preserve existing keys
    expect(raw).toContain("model");
    expect(raw).toContain("mcp_servers");
  });

  it("preserves user-configured servers in shared config files", async () => {
    // OpenCode is shared — pre-populate with a user-added server
    await writeFile(
      join(dir, "opencode.json"),
      JSON.stringify({ mcp: { "my-custom-server": { type: "local", command: ["my-tool"] } } }, null, 2),
      "utf-8",
    );

    await writeMcpConfigs(["opencode"], [STDIO_SERVER], projectMcpResolver(dir));

    const content = JSON.parse(await readFile(join(dir, "opencode.json"), "utf-8"));
    // dotagents-managed server should be present
    expect(content.mcp.github).toBeDefined();
    // User's custom server should NOT be deleted
    expect(content.mcp["my-custom-server"]).toEqual({ type: "local", command: ["my-tool"] });
  });

  it("is idempotent", async () => {
    await writeMcpConfigs(["claude"], [STDIO_SERVER], projectMcpResolver(dir));
    const first = await readFile(join(dir, ".mcp.json"), "utf-8");

    await writeMcpConfigs(["claude"], [STDIO_SERVER], projectMcpResolver(dir));
    const second = await readFile(join(dir, ".mcp.json"), "utf-8");

    expect(first).toBe(second);
  });

  it("creates parent directories as needed", async () => {
    await writeMcpConfigs(["cursor"], [STDIO_SERVER], projectMcpResolver(dir));
    expect(existsSync(join(dir, ".cursor", "mcp.json"))).toBe(true);
  });
});

describe("verifyMcpConfigs", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "dotagents-mcp-verify-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true });
  });

  it("returns no issues when configs match", async () => {
    await writeMcpConfigs(["claude"], [STDIO_SERVER], projectMcpResolver(dir));
    const issues = await verifyMcpConfigs(["claude"], [STDIO_SERVER], projectMcpResolver(dir));
    expect(issues).toEqual([]);
  });

  it("reports missing config file", async () => {
    const issues = await verifyMcpConfigs(["claude"], [STDIO_SERVER], projectMcpResolver(dir));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.issue).toContain("missing");
  });

  it("reports missing server in config", async () => {
    // Write config with only one server
    await writeMcpConfigs(["claude"], [STDIO_SERVER], projectMcpResolver(dir));
    // Verify expecting two servers
    const issues = await verifyMcpConfigs(["claude"], [STDIO_SERVER, HTTP_SERVER], projectMcpResolver(dir));
    expect(issues.some((i) => i.issue.includes("remote"))).toBe(true);
  });

  it("returns empty when no servers declared", async () => {
    const issues = await verifyMcpConfigs(["claude"], [], projectMcpResolver(dir));
    expect(issues).toEqual([]);
  });
});
