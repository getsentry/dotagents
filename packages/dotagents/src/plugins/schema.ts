import { z } from "zod/v4";

// Canonical plugin wire schemas. Known fields are validated for path safety,
// while passthrough preserves native runtime and future dotagents extensions.
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
}).passthrough();

export type PluginManifest = z.infer<typeof pluginManifestSchema>;

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
  const parsed = pluginManifestSchema.safeParse(value);
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
