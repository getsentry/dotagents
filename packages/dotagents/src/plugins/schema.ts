import { z } from "zod/v4";
import { validateHeaderName, validateHeaderValue } from "node:http";
import { isIP } from "node:net";

export const AGENT_PLUGIN_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
export const AGENT_PLUGIN_MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";

const agentPluginNameSchema = z.string().min(1).max(64).regex(
  /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/,
  "Agent Plugin names must use lowercase letters, numbers, hyphens, or dots, have alphanumeric ends, and not contain '--' or '..'",
);

// Legacy manifest component paths are validated before runtime projection.
export const pluginPathSchema = z.string().check(
  z.refine((value) => {
    if (value.length === 0) {return false;}
    if (value.startsWith("/") || value.startsWith("\\")) {return false;}
    if (/^[a-zA-Z]:[\\/]/.test(value)) {return false;}
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) {return false;}
    const parts = value.replaceAll("\\", "/").split("/");
    return !parts.includes("..");
  }, "Plugin paths must be relative filesystem paths and must not contain '..'"),
);

const marketplacePathSchema = z.string().check(
  z.refine((value) => {
    if (value.length === 0) {return false;}
    if (value.startsWith("/") || value.startsWith("\\")) {return false;}
    if (/^[a-zA-Z]:[\\/]/.test(value)) {return false;}
    return !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value);
  }, "Marketplace paths must be relative filesystem paths"),
);

const pluginAuthorSchema = z.object({
  name: z.string().optional(),
  email: z.string().optional(),
  url: z.string().optional(),
}).passthrough();

const standardPluginAuthorSchema = z.object({
  name: z.string().optional(),
  email: z.string().optional(),
  url: z.string().optional(),
}).strict();

const extensionNamespaceSchema = z.string().regex(
  /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/,
  "Agent Plugin extension namespaces must use a lowercase reverse-domain identifier",
);

const standardPluginManifestSchema = z.object({
  $schema: z.literal(AGENT_PLUGIN_SCHEMA),
  name: agentPluginNameSchema,
  description: z.string().optional(),
  version: z.string().optional(),
  author: standardPluginAuthorSchema.optional(),
  homepage: z.string().optional(),
  repository: z.string().optional(),
  license: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  extensions: z.record(extensionNamespaceSchema, z.record(z.string(), z.unknown())).optional(),
});

const pluginPathOrPathsSchema = z.union([
  pluginPathSchema,
  z.array(pluginPathSchema),
]);

export const pluginManifestSchema = z.object({
  name: z.string().optional(),
  version: z.string().optional(),
  description: z.string().optional(),
  author: pluginAuthorSchema.optional(),
  homepage: z.string().optional(),
  repository: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
  license: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  category: z.string().optional(),
  skills: pluginPathOrPathsSchema.optional(),
  agents: pluginPathOrPathsSchema.optional(),
  commands: pluginPathOrPathsSchema.optional(),
  rules: pluginPathOrPathsSchema.optional(),
  hooks: pluginPathSchema.optional(),
  mcpServers: pluginPathSchema.optional(),
  lspServers: pluginPathSchema.optional(),
  apps: pluginPathSchema.optional(),
  monitors: pluginPathSchema.optional(),
  bin: pluginPathOrPathsSchema.optional(),
  extensions: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
}).passthrough();

export type StandardPluginManifest = z.infer<typeof standardPluginManifestSchema>;
export type LegacyPluginManifest = z.infer<typeof pluginManifestSchema> & { $schema?: never };
export type PluginManifest = StandardPluginManifest | LegacyPluginManifest;

export function isStandardPluginManifest(manifest: PluginManifest): manifest is StandardPluginManifest {
  return "$schema" in manifest && manifest.$schema === AGENT_PLUGIN_SCHEMA;
}

const pluginMcpStdioSchema = z.object({
  type: z.literal("stdio"),
  command: z.string().min(1).refine(
    (value) => value.startsWith("./")
      ? pluginPathSchema.safeParse(value).success
      : !/[\\/\s]/.test(value) && !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value),
    "MCP stdio command must be one executable token or a plugin-relative ./ path",
  ),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).check(
    z.refine(
      (value) => !("PLUGIN_ROOT" in value) && !("PLUGIN_DATA" in value),
      "MCP env must not override PLUGIN_ROOT or PLUGIN_DATA",
    ),
  ).optional(),
  cwd: z.string().refine(
    isPortableMcpCwd,
    "MCP cwd must be plugin-relative or rooted at PLUGIN_ROOT or PLUGIN_DATA",
  ).optional(),
}).strict();

function isPortableMcpCwd(value: string): boolean {
  if (value.startsWith("./")) {return pluginPathSchema.safeParse(value).success;}
  for (const placeholder of ["${PLUGIN_ROOT}", "${PLUGIN_DATA}"]) {
    if (value === placeholder) {return true;}
    if (!value.startsWith(`${placeholder}/`)) {continue;}
    const suffix = value.slice(placeholder.length + 1);
    return suffix.length > 0 && pluginPathSchema.safeParse(`./${suffix}`).success;
  }
  return false;
}

const pluginMcpRemoteSchema = z.object({
  type: z.enum(["streamable-http", "sse"]),
  url: z.url().refine(
    isValidRemoteMcpUrl,
    "Remote MCP URLs must be HTTPS, or HTTP on a loopback host, without user information or fragments",
  ),
  headers: z.record(z.string(), z.string()).refine(
    areValidMcpHeaders,
    "Remote MCP headers must be valid HTTP fields with case-insensitively unique names",
  ).optional(),
}).strict();

function isValidRemoteMcpUrl(value: string): boolean {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) {return false;}
  if (url.username || url.password || url.hash) {return false;}
  if (url.protocol === "https:") {return true;}

  const hostname = url.hostname.replaceAll(/^\[|\]$/g, "").toLowerCase();
  if (hostname === "localhost" || hostname === "::1") {return true;}
  if (isIP(hostname) !== 4) {return false;}
  return hostname.split(".")[0] === "127";
}

function areValidMcpHeaders(headers: Record<string, string>): boolean {
  const names = new Set<string>();
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase();
    if (names.has(normalized)) {return false;}
    names.add(normalized);
    try {
      validateHeaderName(name);
      validateHeaderValue(name, value);
    } catch {
      return false;
    }
  }
  return true;
}

const pluginMcpServerSchema = z.union([pluginMcpStdioSchema, pluginMcpRemoteSchema]);

const pluginMcpEnvelopeSchema = z.object({
  $schema: z.literal(AGENT_PLUGIN_MCP_SCHEMA),
  mcpServers: z.record(z.string(), z.unknown()),
}).strict();

export interface PluginMcpConfig {
  $schema: typeof AGENT_PLUGIN_MCP_SCHEMA;
  mcpServers: Record<string, z.infer<typeof pluginMcpServerSchema>>;
}

export function parsePluginMcpBestEffort(
  value: unknown,
  filePath: string,
): { config: PluginMcpConfig; issues: string[] } {
  const envelope = pluginMcpEnvelopeSchema.safeParse(value);
  if (!envelope.success) {
    throw new Error(`Invalid plugin MCP config ${filePath}: ${envelope.error.message}`);
  }
  const mcpServers: PluginMcpConfig["mcpServers"] = {};
  const issues: string[] = [];
  for (const [name, server] of Object.entries(envelope.data.mcpServers)) {
    if (!name) {
      issues.push(`Invalid plugin MCP server name in ${filePath}: server names must not be empty`);
      continue;
    }
    const parsed = pluginMcpServerSchema.safeParse(server);
    if (!parsed.success) {
      issues.push(`Invalid plugin MCP server "${name}" in ${filePath}: ${parsed.error.message}`);
      continue;
    }
    mcpServers[name] = parsed.data;
  }
  return {
    config: { $schema: AGENT_PLUGIN_MCP_SCHEMA, mcpServers },
    issues,
  };
}

export function parsePluginMcp(value: unknown, filePath: string): PluginMcpConfig {
  const parsed = parsePluginMcpBestEffort(value, filePath);
  if (parsed.issues.length > 0) {
    throw new Error(parsed.issues.join("\n"));
  }
  return parsed.config;
}

const localMarketplaceSourceSchema = z.object({
  source: z.literal("local"),
  path: marketplacePathSchema,
}).passthrough();

const extensionMarketplaceSourceSchema = z.object({
  source: z.string().optional(),
  path: pluginPathSchema.optional(),
}).passthrough().check(
  z.refine((value) => value.source !== "local", "Local marketplace sources must include a path"),
);

export const marketplaceSourceSchema = z.union([
  marketplacePathSchema,
  localMarketplaceSourceSchema,
  extensionMarketplaceSourceSchema,
]);

export const marketplacePluginEntrySchema = z.object({
  name: z.string(),
  source: marketplaceSourceSchema,
  description: z.string().optional(),
  version: z.string().optional(),
  category: z.string().optional(),
  policy: z.object({
    installation: z.string().optional(),
    authentication: z.string().optional(),
  }).passthrough().optional(),
  skills: z.array(pluginPathSchema).optional(),
}).passthrough();

export type MarketplacePluginEntry = z.infer<typeof marketplacePluginEntrySchema>;

export const pluginMarketplaceSchema = z.object({
  name: z.string(),
  interface: z.object({
    displayName: z.string().optional(),
  }).passthrough().optional(),
  owner: z.object({
    name: z.string().optional(),
  }).passthrough().optional(),
  metadata: z.object({
    pluginRoot: pluginPathSchema.optional(),
  }).passthrough().optional(),
  plugins: z.array(marketplacePluginEntrySchema),
}).passthrough();

export type PluginMarketplace = z.infer<typeof pluginMarketplaceSchema>;

/** Parses an external plugin manifest and annotates schema errors with its file path. */
export function parsePluginManifest(
  value: unknown,
  filePath: string,
): PluginManifest {
  const recordValue = value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
  const schemaValue = recordValue?.["$schema"];
  const isStandard = schemaValue === AGENT_PLUGIN_SCHEMA;
  if (
    typeof schemaValue === "string" &&
    schemaValue.startsWith("https://agent-plugins.org/schemas/") &&
    !isStandard
  ) {
    throw new Error(`Invalid plugin manifest ${filePath}: unsupported Agent Plugins schema ${schemaValue}`);
  }
  let input = value;
  if (isStandard) {
    const record = { ...(value as Record<string, unknown>) };
    const extensions = record["extensions"];
    if (extensions !== undefined && (extensions === null || typeof extensions !== "object" || Array.isArray(extensions))) {
      delete record["extensions"];
    } else if (extensions !== undefined) {
      record["extensions"] = Object.fromEntries(
        Object.entries(extensions).filter(([, extension]) => (
          extension !== null && typeof extension === "object" && !Array.isArray(extension)
        )),
      );
    }
    input = record;
  } else if (recordValue && "$schema" in recordValue) {
    const record = { ...recordValue };
    delete record["$schema"];
    input = record;
  }
  const parsed = (isStandard ? standardPluginManifestSchema : pluginManifestSchema).safeParse(input);
  if (!parsed.success) {
    throw new Error(`Invalid plugin manifest ${filePath}: ${parsed.error.message}`);
  }
  return parsed.data;
}

/** Parses an external plugin marketplace and annotates schema errors with its file path. */
export function parsePluginMarketplace(
  value: unknown,
  filePath: string,
): PluginMarketplace {
  const parsed = pluginMarketplaceSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Invalid plugin marketplace ${filePath}: ${parsed.error.message}`);
  }
  return parsed.data;
}
