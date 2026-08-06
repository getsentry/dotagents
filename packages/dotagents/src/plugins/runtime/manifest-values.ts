import { isStandardPluginManifest, type LegacyPluginManifest, type PluginManifest } from "../schema.js";

export function manifestString(
  manifest: PluginManifest,
  key: "description" | "version",
): string | undefined {
  const value = manifest[key];
  return typeof value === "string" ? value : undefined;
}

export function legacyManifestString(
  manifest: PluginManifest,
  key: "category",
): string | undefined {
  if (isStandardPluginManifest(manifest)) {return undefined;}
  const value = (manifest as LegacyPluginManifest)[key];
  return typeof value === "string" ? value : undefined;
}

/** Formats an already validated plugin-relative component path. */
export function runtimePath(value: string): string {
  return value.startsWith(".") ? value : `./${value}`;
}

export function titleCase(value: string): string {
  return value
    .split(/[-.]/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}
