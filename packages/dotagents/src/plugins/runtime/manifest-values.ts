import type { PluginManifest } from "../schema.js";

/** Reads string-valued manifest fields for generated plugin projections. */
export function manifestString(manifest: PluginManifest, key: string): string | undefined {
  const value = manifest[key];
  return typeof value === "string" ? value : undefined;
}

/** Normalizes manifest component paths to runtime-relative paths. */
export function runtimePath(value: string): string {
  return value.startsWith(".") ? value : `./${value}`;
}

/** Builds a human-readable display name from a plugin package name. */
export function titleCase(value: string): string {
  return value
    .split(/[-.]/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}
