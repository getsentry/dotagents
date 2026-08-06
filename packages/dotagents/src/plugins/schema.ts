import { z } from "zod/v4";

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
  name: z.string().min(1),
  email: z.email().optional(),
  url: z.url().optional(),
}).strict();

const standardPluginManifestSchema = z.object({
  $schema: z.literal(AGENT_PLUGIN_SCHEMA),
  name: agentPluginNameSchema,
  description: z.string().min(1).optional(),
  version: z.string().min(1).optional(),
  author: standardPluginAuthorSchema.optional(),
  homepage: z.url().optional(),
  repository: z.string().min(1).optional(),
  license: z.string().min(1).optional(),
  keywords: z.array(z.string().min(1)).optional(),
  extensions: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
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
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
}).strict();

const pluginMcpRemoteSchema = z.object({
  type: z.enum(["streamable-http", "sse"]),
  url: z.url(),
  headers: z.record(z.string(), z.string()).optional(),
}).strict();

const pluginMcpSchema = z.object({
  $schema: z.literal(AGENT_PLUGIN_MCP_SCHEMA),
  mcpServers: z.record(z.string().min(1), z.union([pluginMcpStdioSchema, pluginMcpRemoteSchema])),
}).strict();

type PluginMcpConfig = z.infer<typeof pluginMcpSchema>;

export function parsePluginMcp(value: unknown, filePath: string): PluginMcpConfig {
  const parsed = pluginMcpSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Invalid plugin MCP config ${filePath}: ${parsed.error.message}`);
  }
  return parsed.data;
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
  const isStandard = value !== null && typeof value === "object" && !Array.isArray(value) && "$schema" in value;
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
