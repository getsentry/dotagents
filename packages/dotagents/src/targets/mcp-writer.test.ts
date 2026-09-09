import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmod, mkdtemp, mkdir, readFile, writeFile, rm, stat, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { parse as parseJSONC } from "jsonc-parser";
import { parse as parseTOML } from "smol-toml";
import {
  projectMcpResolver,
  reconcileManagedMcpConfig,
  reconcileMcpConfigs,
  verifyMcpConfigs,
  writeMcpConfigs,
} from "./mcp-writer.js";
import type { McpDeclaration } from "./types.js";
import { isSerializedObject, type SerializedObject } from "@sentry/dotagents-lib";

function parseJsoncObject(content: string): SerializedObject {
  const parsed = parseJSONC(content);
  if (!isSerializedObject(parsed)) {throw new Error("expected a serialized JSONC object");}
  return parsed;
}

function parseTomlObject(content: string): SerializedObject {
  const parsed = parseTOML(content);
  if (!isSerializedObject(parsed)) {throw new Error("expected a serialized TOML object");}
  return parsed;
}

function childObject(document: SerializedObject, key: string): SerializedObject {
  const value = document[key];
  if (!isSerializedObject(value)) {throw new Error(`expected object field ${key}`);}
  return value;
}

const STDIO_SERVER: McpDeclaration = {
  name: "github",
  command: "npx",
  args: ["-y", "@mcp/server-github"],
  env: ["GITHUB_TOKEN"],
};

const HTTP_SERVER: McpDeclaration = {
  name: "remote",
  url: "https://mcp.example.com/mcp",
  headers: { Authorization: "Bearer tok" },
};

const HTTP_SERVER_WITH_ENV_REFS: McpDeclaration = {
  name: "authed-api",
  url: "https://${API_HOST}/mcp",
  headers: { "X-Api-Key": "${API_KEY}", Authorization: "Bearer ${TOKEN}" },
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
    const filePath = join(dir, ".mcp.json");
    const existing = JSON.stringify({ mcpServers: { manual: { command: "manual" } } });
    await writeFile(filePath, existing);

    await writeMcpConfigs(["claude"], [], projectMcpResolver(dir));

    expect(await readFile(filePath, "utf-8")).toBe(existing);
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

  it("writes codex stdio environment names and literal values in their native fields", async () => {
    await writeMcpConfigs(["codex"], [{
      ...STDIO_SERVER,
      envValues: { PLUGIN_ROOT: "/plugins/github" },
    }], projectMcpResolver(dir));

    const content = parseTomlObject(
      await readFile(join(dir, ".codex", "config.toml"), "utf-8"),
    );
    expect(childObject(content, "mcp_servers")["github"]).toEqual({
      command: "npx",
      args: ["-y", "@mcp/server-github"],
      env: { PLUGIN_ROOT: "/plugins/github" },
      env_vars: ["GITHUB_TOKEN"],
    });
  });

  it("rejects a project config directory that resolves outside the project", async () => {
    const outside = await mkdtemp(join(tmpdir(), "dotagents-mcp-outside-"));
    await symlink(outside, join(dir, ".codex"), process.platform === "win32" ? "junction" : "dir");

    try {
      await expect(
        writeMcpConfigs(["codex"], [STDIO_SERVER], projectMcpResolver(dir)),
      ).rejects.toThrow(/outside the project root/);
      expect(existsSync(join(outside, "config.toml"))).toBe(false);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("writes .opencode/opencode.jsonc by default", async () => {
    await writeMcpConfigs(["opencode"], [STDIO_SERVER], projectMcpResolver(dir));

    const content = JSON.parse(
      await readFile(join(dir, ".opencode", "opencode.jsonc"), "utf-8"),
    );
    expect(content.mcp.github).toEqual({
      type: "local",
      command: ["npx", "-y", "@mcp/server-github"],
      environment: { GITHUB_TOKEN: "${GITHUB_TOKEN}" },
    });
  });

  it("writes literal environment values and cwd for adapter-provided OpenCode servers", async () => {
    await writeMcpConfigs(["opencode"], [{
      name: "plugin.qa.local",
      command: "node",
      args: ["/plugins/qa/server.mjs"],
      cwd: "/plugins/qa",
      envValues: {
        PLUGIN_ROOT: "/plugins/qa",
        PLUGIN_DATA: "/data/qa",
      },
    }], projectMcpResolver(dir));

    const content = JSON.parse(
      await readFile(join(dir, ".opencode", "opencode.jsonc"), "utf-8"),
    );
    expect(content.mcp["plugin.qa.local"]).toEqual({
      type: "local",
      command: ["node", "/plugins/qa/server.mjs"],
      cwd: "/plugins/qa",
      environment: {
        PLUGIN_ROOT: "/plugins/qa",
        PLUGIN_DATA: "/data/qa",
      },
    });
  });

  it("reconciles and prunes an owned MCP subset without touching user JSONC", async () => {
    const filePath = join(dir, ".opencode", "opencode.jsonc");
    const statePath = join(dir, ".agents", "plugin-mcp", "opencode.json");
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, [
      "{",
      "  // Keep this setting and server",
      '  "theme": "dark",',
      '  "mcp": {',
      '    "manual": { "type": "local", "command": ["manual"] },',
      "  },",
      "}",
      "",
    ].join("\n"));

    await reconcileManagedMcpConfig({
      agentId: "opencode",
      servers: [{ name: "plugin.qa.remote", url: "https://example.com/mcp" }],
      target: { filePath, shared: true },
      statePath,
      mode: "apply",
    });
    let raw = await readFile(filePath, "utf-8");
    expect(raw).toContain("// Keep this setting and server");
    expect(childObject(parseJsoncObject(raw), "mcp")["plugin.qa.remote"]).toEqual({
      type: "remote",
      url: "https://example.com/mcp",
    });
    expect(JSON.parse(await readFile(statePath, "utf-8"))).toEqual({
      version: 1,
      servers: ["plugin.qa.remote"],
    });

    await reconcileManagedMcpConfig({
      agentId: "opencode",
      servers: [],
      target: { filePath, shared: true },
      statePath,
      mode: "apply",
    });
    raw = await readFile(filePath, "utf-8");
    const parsed = parseJsoncObject(raw);
    expect(raw).toContain("// Keep this setting and server");
    expect(parsed["theme"]).toBe("dark");
    expect(childObject(parsed, "mcp")["manual"]).toEqual({ type: "local", command: ["manual"] });
    expect(childObject(parsed, "mcp")["plugin.qa.remote"]).toBeUndefined();
    expect(existsSync(statePath)).toBe(false);
  });

  it("does not overwrite an unmanaged flattened MCP collision", async () => {
    const filePath = join(dir, ".opencode", "opencode.jsonc");
    const statePath = join(dir, ".agents", "plugin-mcp", "opencode.json");
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify({
      mcp: { "plugin.qa.remote": { type: "local", command: ["mine"] } },
    }));

    const result = await reconcileManagedMcpConfig({
      agentId: "opencode",
      servers: [{ name: "plugin.qa.remote", url: "https://example.com/mcp" }],
      target: { filePath, shared: true },
      statePath,
      mode: "apply",
    });

    expect(result.skipped).toHaveLength(1);
    expect(JSON.parse(await readFile(filePath, "utf-8")).mcp["plugin.qa.remote"]).toEqual({
      type: "local",
      command: ["mine"],
    });
    expect(existsSync(statePath)).toBe(false);
  });

  it.each([
    join(".opencode", "opencode.json"),
    "opencode.jsonc",
    "opencode.json",
  ])("uses existing OpenCode config at %s", async (relativePath) => {
    const filePath = join(dir, relativePath);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify({ mcp: {} }));

    await writeMcpConfigs(["opencode"], [STDIO_SERVER], projectMcpResolver(dir));

    const content = JSON.parse(await readFile(filePath, "utf-8"));
    expect(content.mcp.github).toBeDefined();
    expect(existsSync(join(dir, ".opencode", "opencode.jsonc"))).toBe(false);
  });

  it.each([
    [["copilot"], false],
    [["claude", "copilot"], true],
  ] as const)("reconciles a bare .mcp.json for %s", async (agents, rooted) => {
    const filePath = join(dir, ".mcp.json");
    await writeFile(filePath, JSON.stringify({
      manual: { command: "manual", args: [] },
      github: { command: "old", args: [] },
    }));

    await writeMcpConfigs([...agents], [STDIO_SERVER], projectMcpResolver(dir));

    const content = JSON.parse(await readFile(filePath, "utf-8"));
    const servers = rooted ? content.mcpServers : content;
    expect(Object.hasOwn(content, "mcpServers")).toBe(rooted);
    expect(servers.manual).toEqual({ command: "manual", args: [] });
    expect(servers.github.command).toBe("npx");
  });

  it("keeps a bare Copilot fallback in place", async () => {
    const filePath = join(dir, ".github", "mcp.json");
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify({
      manual: { command: "manual", args: [] },
    }));

    await writeMcpConfigs(["copilot"], [STDIO_SERVER], projectMcpResolver(dir));

    const content = JSON.parse(await readFile(filePath, "utf-8"));
    expect(existsSync(join(dir, ".mcp.json"))).toBe(false);
    expect(content.manual.command).toBe("manual");
    expect(content.github.command).toBe("npx");
  });

  it.each([
    ["claude", "copilot"],
    ["copilot", "claude"],
  ] as const)("seeds shared .mcp.json from the fallback for %s first", async (first, second) => {
    const preferredPath = join(dir, ".mcp.json");
    const fallbackPath = join(dir, ".github", "mcp.json");
    const fallback = {
      manual: { command: "manual", args: [] },
    };
    await mkdir(dirname(fallbackPath), { recursive: true });
    await writeFile(fallbackPath, JSON.stringify(fallback));

    await writeMcpConfigs([first, second], [STDIO_SERVER], projectMcpResolver(dir));

    const content = JSON.parse(await readFile(preferredPath, "utf-8"));
    expect(content.mcpServers.manual).toEqual(fallback.manual);
    expect(content.mcpServers.github.command).toBe("npx");
    expect(JSON.parse(await readFile(fallbackPath, "utf-8"))).toEqual(fallback);
  });

  it("handles multiple servers", async () => {
    await writeMcpConfigs(["claude"], [STDIO_SERVER, HTTP_SERVER], projectMcpResolver(dir));

    const content = JSON.parse(await readFile(join(dir, ".mcp.json"), "utf-8"));
    expect(Object.keys(content.mcpServers)).toHaveLength(2);
    expect(content.mcpServers.github).toBeDefined();
    expect(content.mcpServers.remote).toBeDefined();
  });

  it("writes correct HTTP servers for all agents", async () => {
    const allAgents = ["claude", "cursor", "vscode", "opencode", "codex"];
    await writeMcpConfigs(allAgents, [STDIO_SERVER, HTTP_SERVER], projectMcpResolver(dir));

    // Claude
    const claude = JSON.parse(await readFile(join(dir, ".mcp.json"), "utf-8"));
    expect(claude.mcpServers.remote).toEqual({
      type: "http",
      url: "https://mcp.example.com/mcp",
      headers: { Authorization: "Bearer tok" },
    });

    // Cursor
    const cursor = JSON.parse(await readFile(join(dir, ".cursor", "mcp.json"), "utf-8"));
    expect(cursor.mcpServers.remote).toEqual({
      url: "https://mcp.example.com/mcp",
      headers: { Authorization: "Bearer tok" },
    });

    // VS Code
    const vscode = JSON.parse(await readFile(join(dir, ".vscode", "mcp.json"), "utf-8"));
    expect(vscode.servers.remote).toEqual({
      type: "http",
      url: "https://mcp.example.com/mcp",
      headers: { Authorization: "Bearer tok" },
    });

    // OpenCode
    const opencode = JSON.parse(
      await readFile(join(dir, ".opencode", "opencode.jsonc"), "utf-8"),
    );
    expect(opencode.mcp.remote).toEqual({
      type: "remote",
      url: "https://mcp.example.com/mcp",
      headers: { Authorization: "Bearer tok" },
    });

    // Codex
    const raw = await readFile(join(dir, ".codex", "config.toml"), "utf-8");
    const codex = parseTomlObject(raw);
    expect(childObject(codex, "mcp_servers")["remote"]).toEqual({
      url: "https://mcp.example.com/mcp",
      http_headers: { Authorization: "Bearer tok" },
    });
  });

  it("merges into existing shared config file", async () => {
    // Codex config.toml is shared — write something else first
    const codexDir = join(dir, ".codex");
    await mkdir(codexDir, { recursive: true });
    await writeFile(join(codexDir, "config.toml"), 'model = "o3"\n', "utf-8");

    await writeMcpConfigs(["codex"], [STDIO_SERVER], projectMcpResolver(dir));

    const raw = await readFile(join(codexDir, "config.toml"), "utf-8");
    // Should preserve existing keys
    expect(raw).toContain("model");
    expect(raw).toContain("mcp_servers");
  });

  it("preserves TOML special floats in shared config files", async () => {
    const codexDir = join(dir, ".codex");
    await mkdir(codexDir, { recursive: true });
    await writeFile(join(codexDir, "config.toml"), "temperature = inf\n", "utf-8");

    await writeMcpConfigs(["codex"], [STDIO_SERVER], projectMcpResolver(dir));

    const config = parseTOML(await readFile(join(codexDir, "config.toml"), "utf-8"));
    expect(config["temperature"]).toBe(Number.POSITIVE_INFINITY);
    expect(config["mcp_servers"]).toBeDefined();
  });

  it("preserves user-configured servers in shared config files", async () => {
    // OpenCode is shared — pre-populate the legacy path with a user-added server
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

  it("prefers an existing nested JSONC config over legacy root config", async () => {
    const nestedPath = join(dir, ".opencode", "opencode.jsonc");
    const legacyPath = join(dir, "opencode.json");
    await mkdir(dirname(nestedPath), { recursive: true });
    await writeFile(nestedPath, "{\n  // Keep this comment\n  \"theme\": \"dark\",\n  \"mcp\": {},\n}\n");
    await writeFile(legacyPath, JSON.stringify({ mcp: { legacy: { command: ["legacy"] } } }));

    await writeMcpConfigs(["opencode"], [STDIO_SERVER], projectMcpResolver(dir));

    const nested = await readFile(nestedPath, "utf-8");
    expect(nested).toContain("// Keep this comment");
    expect(
      childObject(parseJsoncObject(nested), "mcp")["github"],
    ).toBeDefined();
    expect(JSON.parse(await readFile(legacyPath, "utf-8"))).toEqual({
      mcp: { legacy: { command: ["legacy"] } },
    });
  });

  it("preserves JSONC comments and trailing commas while repairing drift", async () => {
    const filePath = join(dir, ".opencode", "opencode.jsonc");
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(
      filePath,
      [
        "{",
        "  // Project theme must remain documented",
        '  "theme": "dark",',
        '  "mcp": {',
        "    // User-owned server",
        '    "manual": { "type": "local", "command": ["manual"] },',
        '    "github": { "type": "local", "command": ["old"] },',
        "  },",
        "}",
        "",
      ].join("\n"),
    );

    await writeMcpConfigs(["opencode"], [STDIO_SERVER], projectMcpResolver(dir));

    const raw = await readFile(filePath, "utf-8");
    expect(raw).toContain("// Project theme must remain documented");
    expect(raw).toContain("// User-owned server");
    expect(raw).toMatch(/"github": \{[\s\S]*?\n    },\n  },\n}\n$/);
    const content = parseJsoncObject(raw);
    expect(childObject(content, "mcp")["manual"]).toEqual({ type: "local", command: ["manual"] });
    expect(childObject(content, "mcp")["github"]).toEqual({
      type: "local",
      command: ["npx", "-y", "@mcp/server-github"],
      environment: { GITHUB_TOKEN: "${GITHUB_TOKEN}" },
    });
  });

  it("reports malformed OpenCode JSONC without overwriting it", async () => {
    const filePath = join(dir, ".opencode", "opencode.jsonc");
    const malformed = '{\n  // broken\n  "mcp": { nope }\n}\n';
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, malformed);

    const result = await reconcileMcpConfigs(
      ["opencode"],
      [STDIO_SERVER],
      projectMcpResolver(dir),
      "apply",
    );

    expect(result.unresolved).toEqual([
      expect.objectContaining({ issue: expect.stringContaining("Failed to read") }),
    ]);
    expect(result.written).toEqual([]);
    expect(await readFile(filePath, "utf-8")).toBe(malformed);
  });

  it("does not rewrite unchanged shared config files", async () => {
    const filePath = join(dir, ".claude.json");
    const resolver = () => ({ filePath, shared: true });

    await writeMcpConfigs(["claude"], [HTTP_SERVER], resolver);
    const first = await stat(filePath, { bigint: true });

    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeMcpConfigs(["claude"], [HTTP_SERVER], resolver);
    const second = await stat(filePath, { bigint: true });

    expect(second.mtimeNs).toBe(first.mtimeNs);
  });

  it.skipIf(process.platform === "win32")(
    "repairs a restrictive user config mode before reconciliation",
    async () => {
      const filePath = join(dir, "copilot", "mcp-config.json");
      const resolver = () => ({ filePath, shared: false, mode: 0o600 });

      await writeMcpConfigs(["copilot"], [STDIO_SERVER], resolver);
      expect((await stat(filePath)).mode & 0o777).toBe(0o600);
      await writeFile(filePath, JSON.stringify({
        mcpServers: { github: { command: "old", args: [] } },
      }));
      await chmod(filePath, 0o000);

      const result = await reconcileMcpConfigs(
        ["copilot"],
        [STDIO_SERVER],
        resolver,
        "apply",
      );

      expect(result.unresolved).toEqual([]);
      expect(result.written).toEqual([filePath]);
      expect((await stat(filePath)).mode & 0o777).toBe(0o600);
      expect(JSON.parse(await readFile(filePath, "utf-8")).mcpServers.github.command).toBe("npx");
    },
  );

  it.skipIf(process.platform === "win32")(
    "does not chmod or overwrite a config through a symlink",
    async () => {
      const filePath = join(dir, "copilot", "mcp-config.json");
      const unrelatedPath = join(dir, "unrelated-config.json");
      const resolver = () => ({ filePath, shared: false, mode: 0o600 });
      const original = JSON.stringify({ mcpServers: { github: { command: "unmanaged" } } });
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(unrelatedPath, original);
      await chmod(unrelatedPath, 0o644);
      await symlink(unrelatedPath, filePath);

      const result = await reconcileMcpConfigs(
        ["copilot"],
        [STDIO_SERVER],
        resolver,
        "apply",
      );

      expect(result.unresolved).toEqual([
        expect.objectContaining({ issue: expect.stringContaining("not a regular file") }),
      ]);
      expect(result.written).toEqual([]);
      expect((await stat(unrelatedPath)).mode & 0o777).toBe(0o644);
      expect(await readFile(unrelatedPath, "utf-8")).toBe(original);
    },
  );

  it("interpolates env refs in claude HTTP headers/URL with ${VAR} syntax", async () => {
    await writeMcpConfigs(["claude"], [HTTP_SERVER_WITH_ENV_REFS], projectMcpResolver(dir));

    const content = JSON.parse(await readFile(join(dir, ".mcp.json"), "utf-8"));
    expect(content.mcpServers["authed-api"]).toEqual({
      type: "http",
      url: "https://${API_HOST}/mcp",
      headers: { "X-Api-Key": "${API_KEY}", Authorization: "Bearer ${TOKEN}" },
    });
  });

  it("interpolates env refs in cursor HTTP headers/URL with ${env:VAR} syntax", async () => {
    await writeMcpConfigs(["cursor"], [HTTP_SERVER_WITH_ENV_REFS], projectMcpResolver(dir));

    const content = JSON.parse(await readFile(join(dir, ".cursor", "mcp.json"), "utf-8"));
    expect(content.mcpServers["authed-api"]).toEqual({
      url: "https://${env:API_HOST}/mcp",
      headers: { "X-Api-Key": "${env:API_KEY}", Authorization: "Bearer ${env:TOKEN}" },
    });
  });

  it("interpolates env refs in vscode HTTP headers/URL with ${env:VAR} syntax", async () => {
    await writeMcpConfigs(["vscode"], [HTTP_SERVER_WITH_ENV_REFS], projectMcpResolver(dir));

    const content = JSON.parse(await readFile(join(dir, ".vscode", "mcp.json"), "utf-8"));
    expect(content.servers["authed-api"]).toEqual({
      type: "http",
      url: "https://${env:API_HOST}/mcp",
      headers: { "X-Api-Key": "${env:API_KEY}", Authorization: "Bearer ${env:TOKEN}" },
    });
  });

  it("interpolates env refs in opencode HTTP headers/URL with {env:VAR} syntax", async () => {
    await writeMcpConfigs(["opencode"], [HTTP_SERVER_WITH_ENV_REFS], projectMcpResolver(dir));

    const content = JSON.parse(
      await readFile(join(dir, ".opencode", "opencode.jsonc"), "utf-8"),
    );
    expect(content.mcp["authed-api"]).toEqual({
      type: "remote",
      url: "https://{env:API_HOST}/mcp",
      headers: { "X-Api-Key": "{env:API_KEY}", Authorization: "Bearer {env:TOKEN}" },
    });
  });

  it("preserves literal HTTP placeholder-like values for adapter declarations", async () => {
    const literal = { ...HTTP_SERVER_WITH_ENV_REFS, interpolateEnvRefs: false };
    await writeMcpConfigs(["opencode", "codex"], [literal], projectMcpResolver(dir));

    const openCode = JSON.parse(
      await readFile(join(dir, ".opencode", "opencode.jsonc"), "utf-8"),
    );
    expect(openCode.mcp["authed-api"]).toEqual({
      type: "remote",
      url: "https://${API_HOST}/mcp",
      headers: { "X-Api-Key": "${API_KEY}", Authorization: "Bearer ${TOKEN}" },
    });

    const codex = parseTomlObject(
      await readFile(join(dir, ".codex", "config.toml"), "utf-8"),
    );
    expect(childObject(codex, "mcp_servers")["authed-api"]).toEqual({
      url: "https://${API_HOST}/mcp",
      http_headers: {
        "X-Api-Key": "${API_KEY}",
        Authorization: "Bearer ${TOKEN}",
      },
    });
  });

  it("splits codex env refs into env_http_headers for pure refs", async () => {
    await writeMcpConfigs(["codex"], [HTTP_SERVER_WITH_ENV_REFS], projectMcpResolver(dir));

    const raw = await readFile(join(dir, ".codex", "config.toml"), "utf-8");
    const content = parseTomlObject(raw);
    expect(childObject(content, "mcp_servers")["authed-api"]).toEqual({
      url: "https://${API_HOST}/mcp",
      // Pure ref: X-Api-Key = "${API_KEY}" → env_http_headers.X-Api-Key = "API_KEY"
      env_http_headers: { "X-Api-Key": "API_KEY" },
      // Mixed ref stays as literal in http_headers
      http_headers: { Authorization: "Bearer ${TOKEN}" },
    });
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

  it.each([
    ["non-object document", "null\n"],
    ["non-object MCP root", '{"mcpServers": []}\n'],
  ])("reports a %s without changing it", async (_description, content) => {
    const filePath = join(dir, ".mcp.json");
    await writeFile(filePath, content);

    const inspected = await reconcileMcpConfigs(
      ["claude"],
      [STDIO_SERVER],
      projectMcpResolver(dir),
      "inspect",
    );
    expect(inspected.issues).toEqual([
      expect.objectContaining({ issue: expect.stringContaining("Failed to read") }),
    ]);
    expect(await readFile(filePath, "utf-8")).toBe(content);

    const applied = await reconcileMcpConfigs(
      ["claude"],
      [STDIO_SERVER],
      projectMcpResolver(dir),
      "apply",
    );
    expect(applied.written).toEqual([]);
    expect(await readFile(filePath, "utf-8")).toBe(content);
  });

  it("returns empty when no servers declared", async () => {
    await writeFile(
      join(dir, ".mcp.json"),
      JSON.stringify({ mcpServers: { manual: { command: "manual" } } }),
    );

    const issues = await verifyMcpConfigs(["claude"], [], projectMcpResolver(dir));

    expect(issues).toEqual([]);
  });

  it("repairs declared transport drift while preserving external content", async () => {
    const filePath = join(dir, ".mcp.json");
    const expected = {
      editor: "manual",
      mcpServers: {
        manual: { command: "manual" },
        github: {
          command: "npx",
          args: ["-y", "@mcp/server-github"],
          env: { GITHUB_TOKEN: "${GITHUB_TOKEN}" },
        },
        remote: {
          type: "http",
          url: "https://mcp.example.com/mcp",
          headers: { Authorization: "Bearer tok" },
        },
      },
    };
    await writeFile(filePath, JSON.stringify({
      editor: "manual",
      mcpServers: {
        manual: { command: "manual" },
        github: { command: "old", args: ["old"], env: { GITHUB_TOKEN: "old" } },
        remote: { type: "http", url: "https://old.example.com", headers: { Authorization: "old" } },
      },
    }));

    const resolver = projectMcpResolver(dir);
    const inspected = await reconcileMcpConfigs(
      ["claude"],
      [STDIO_SERVER, HTTP_SERVER],
      resolver,
      "inspect",
    );
    expect(inspected.issues.map((issue) => issue.issue)).toEqual([
      expect.stringContaining('"github" drifted'),
      expect.stringContaining('"remote" drifted'),
    ]);

    const applied = await reconcileMcpConfigs(
      ["claude"],
      [STDIO_SERVER, HTTP_SERVER],
      resolver,
      "apply",
    );
    expect(applied.written).toEqual([filePath]);
    expect(JSON.parse(await readFile(filePath, "utf-8"))).toEqual(expected);

    await writeFile(filePath, JSON.stringify({
      ...expected,
      mcpServers: { ...expected.mcpServers, stale: { command: "stale" } },
    }));
    const stale = await reconcileMcpConfigs(
      ["claude"],
      [STDIO_SERVER, HTTP_SERVER],
      resolver,
      "apply",
    );
    expect(stale).toEqual({ issues: [], unresolved: [], written: [] });
    expect(JSON.parse(await readFile(filePath, "utf-8"))).toEqual({
      ...expected,
      mcpServers: { ...expected.mcpServers, stale: { command: "stale" } },
    });
  });

  it.each([
    {
      agent: "cursor",
      relativePath: join(".cursor", "mcp.json"),
      content: JSON.stringify({ mcpServers: { manual: { command: "manual" } } }),
    },
    {
      agent: "opencode",
      relativePath: join(".opencode", "opencode.jsonc"),
      content: JSON.stringify({
        theme: "dark",
        mcp: { manual: { type: "local", command: ["manual"] } },
      }, null, 2),
    },
  ])("leaves $agent files unchanged when no servers are desired", async ({
    agent,
    relativePath,
    content,
  }) => {
    const filePath = join(dir, relativePath);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, content);

    const result = await reconcileMcpConfigs(
      [agent],
      [],
      projectMcpResolver(dir),
      "apply",
    );

    expect(result).toEqual({ issues: [], unresolved: [], written: [] });
    expect(await readFile(filePath, "utf-8")).toBe(content);
  });
});
