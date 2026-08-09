import type { PluginManifest } from "./schema.js";

export type NativePluginSource = "claude" | "cursor" | "codex";

export interface PluginDeclaration {
  name: string;
  source: string;
  pluginDir: string;
  manifest: PluginManifest;
  nativeSource?: NativePluginSource;
  targets?: string[];
}
