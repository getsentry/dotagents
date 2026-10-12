import { isDeepStrictEqual } from "node:util";
import { isSerializedObject, type SerializedObject, type SerializedValue } from "../utils/serialized.js";
import { isString } from "../utils/type-guards.js";
import {
  isStandardPluginManifest,
  type LegacyPluginManifest,
  type PluginManifest,
  type PluginMcpConfig,
} from "./schema.js";
import type { NativePluginSource } from "./types.js";

// Owns the native manifest fields that a portable plugin core can reproduce.
// Resolution uses this to classify authored native manifests; hosts that
// generate native adapters must use the same values so the two stay in sync.

export const NATIVE_PLUGIN_SOURCES: readonly NativePluginSource[] = ["claude", "cursor", "codex"];

export const NATIVE_PLUGIN_MANIFEST_PATHS: ReadonlyArray<{
  source: NativePluginSource;
  path: string;
}> = [
  { source: "claude", path: ".claude-plugin/plugin.json" },
  { source: "cursor", path: ".cursor-plugin/plugin.json" },
  { source: "codex", path: ".codex-plugin/plugin.json" },
];

const GENERATED_NATIVE_FIELDS = {
  claude: new Set(["$schema", "name", "version", "description", "author", "homepage", "repository", "license", "keywords", "skills"]),
  cursor: new Set(["$schema", "name", "version", "description", "author", "homepage", "repository", "license", "keywords", "skills"]),
  codex: new Set(["$schema", "name", "version", "description", "author", "homepage", "repository", "license", "keywords", "skills"]),
} satisfies Record<NativePluginSource, ReadonlySet<string>>;

/** Returns the display name for a native plugin client. */
export function nativePluginDisplayName(source: NativePluginSource): string {
  return source === "claude" ? "Claude" : source === "cursor" ? "Cursor" : "Codex";
}

/** Returns whether a native manifest contains behavior the target adapter cannot generate from the portable core. */
export function nativeInterfaceNeedsFallback(
  source: NativePluginSource,
  value: SerializedValue,
  reproducibleFields: SerializedObject = {},
): boolean {
  if (!isSerializedObject(value)) {return true;}
  for (const [key, field] of Object.entries(value)) {
    if (reproducibleFields[key] !== undefined && isDeepStrictEqual(field, reproducibleFields[key])) {
      continue;
    }
    if (!GENERATED_NATIVE_FIELDS[source].has(key)) {return true;}
    if (key === "skills" && !isConventionalSkillsReference(field)) {return true;}
  }
  return false;
}

/** Returns the native MCP reference generated from a portable MCP parse result. */
export function generatedNativeMcpPath(
  source: NativePluginSource,
  portableMcp: { config?: PluginMcpConfig; issues: string[] } | undefined,
): string | undefined {
  if (!portableMcp?.config) {return undefined;}
  if (portableMcp.issues.length === 0) {return "./mcp.json";}
  if (Object.keys(portableMcp.config.mcpServers).length > 0) {
    return `./.${source}-plugin/mcp.json`;
  }
  return undefined;
}

function isConventionalSkillsReference(value: SerializedValue | undefined): boolean {
  const values = Array.isArray(value) ? value : [value];
  return values.length === 1 && isString(values[0]) &&
    values[0].replace(/^\.\//, "").replace(/\/$/, "") === "skills";
}

/** Returns a string metadata field from either manifest variant. */
export function manifestString(
  manifest: PluginManifest,
  key: "description" | "version",
): string | undefined {
  const value = manifest[key];
  return isString(value) ? value : undefined;
}

/** Returns a non-empty legacy-only metadata field. */
export function legacyManifestString(
  manifest: PluginManifest,
  key: "category",
): string | undefined {
  if (isStandardPluginManifest(manifest)) {return undefined;}
  // SAFETY: the standard-manifest guard above leaves the legacy manifest variant.
  const value = (manifest as LegacyPluginManifest)[key];
  return isString(value) && value.length > 0 ? value : undefined;
}

function titleCase(value: string): string {
  return value
    .split(/[-.]/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

/** Returns the Codex `interface` block generated from a portable manifest. */
export function codexPluginInterface(name: string, manifest: PluginManifest): SerializedObject {
  return {
    displayName: titleCase(name),
    shortDescription: manifestString(manifest, "description") ?? "",
    developerName: manifest.author && isString(manifest.author.name)
      ? manifest.author.name
      : "Unknown",
    category: legacyManifestString(manifest, "category") ?? "Coding",
    capabilities: ["Interactive", "Write"],
  };
}
