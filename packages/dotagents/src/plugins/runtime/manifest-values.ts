import type { SerializedObject } from "@sentry/dotagents-lib";
import { isStandardPluginManifest, type LegacyPluginManifest, type PluginManifest } from "../schema.js";
import { isString } from "../../utils/type-guards.js";

export function manifestString(
  manifest: PluginManifest,
  key: "description" | "version",
): string | undefined {
  const value = manifest[key];
  return isString(value) ? value : undefined;
}

export function legacyManifestString(
  manifest: PluginManifest,
  key: "category",
): string | undefined {
  if (isStandardPluginManifest(manifest)) {return undefined;}
  // SAFETY: the standard-manifest guard above leaves the legacy manifest variant.
  const value = (manifest as LegacyPluginManifest)[key];
  return isString(value) && value.length > 0 ? value : undefined;
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
