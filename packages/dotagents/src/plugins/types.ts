import type { PluginManifest } from "./schema.js";

export type NativePluginSource = "claude" | "cursor" | "codex";

export type AuthoredNativePluginInterface =
  | { path: string; fallback: boolean; manifest: PluginManifest; error?: never }
  | { path: string; fallback: boolean; manifest?: never; error: string };

export type AuthoredNativePluginInterfaces = Partial<
  Record<NativePluginSource, AuthoredNativePluginInterface>
>;

export interface PluginDeclaration {
  name: string;
  source: string;
  pluginDir: string;
  manifest: PluginManifest;
  authoredNativeInterfaces?: AuthoredNativePluginInterfaces;
  compatibilityWarnings?: string[];
  nativeSource?: NativePluginSource;
  targets?: string[];
}
