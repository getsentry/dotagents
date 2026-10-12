import type { PluginManifest } from "./schema.js";

export type NativePluginSource = "claude" | "cursor" | "codex";

/**
 * A client-specific manifest authored next to the portable plugin core.
 * `fallback` is true when the portable core cannot reproduce it, so the
 * matching client must keep the authored manifest.
 */
export type AuthoredNativePluginInterface =
  | { path: string; fallback: boolean; manifest: PluginManifest; error?: never }
  | { path: string; fallback: boolean; manifest?: never; error: string };

export type AuthoredNativePluginInterfaces = Partial<
  Record<NativePluginSource, AuthoredNativePluginInterface>
>;

/** A validated plugin directory with its effective manifest. */
export interface PluginBundle {
  name: string;
  source: string;
  pluginDir: string;
  manifest: PluginManifest;
  authoredNativeInterfaces?: AuthoredNativePluginInterfaces;
  nativeSource?: NativePluginSource;
}
