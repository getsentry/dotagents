import { relative } from "node:path";
import type { PluginManifest } from "../schema.js";
import { isSafeComponentPath } from "./component-paths.js";

/** Reads string-valued manifest fields for generated plugin projections. */
export function manifestString(manifest: PluginManifest, key: string): string | undefined {
  const value = manifest[key];
  return typeof value === "string" ? value : undefined;
}

/** Normalizes manifest component paths to runtime-relative paths. */
export function runtimePath(value: string): string {
  return value.startsWith(".") ? value : `./${value}`;
}

/** Normalizes only path-safe manifest component paths. */
export function safeRuntimePath(value: string): string | null {
  return isSafeComponentPath(value) ? runtimePath(value) : null;
}

/** Builds a human-readable display name from a plugin package name. */
export function titleCase(value: string): string {
  return value
    .split(/[-.]/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

/** Formats generated plugin paths with POSIX separators. */
export function relativePath(from: string, to: string): string {
  const path = relative(from, to).split("\\").join("/");
  return path.startsWith(".") ? path : `./${path}`;
}
