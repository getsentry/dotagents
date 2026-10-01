import type { PluginBundle } from "@sentry/dotagents-lib";

/** A resolved or installed plugin plus the dotagents target selection for it. */
export interface PluginDeclaration extends PluginBundle {
  compatibilityWarnings?: string[];
  targets?: string[];
}
