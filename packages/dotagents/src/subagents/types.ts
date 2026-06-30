import type { SubagentConfig } from "../config/schema.js";

/**
 * Universal subagent declaration loaded from an installed subagent Markdown file.
 */
export interface SubagentDeclaration {
  name: string;
  description: string;
  instructions: string;
  targets?: SubagentConfig["targets"];
  native?: NativeSubagentContent;
}

export type NativeSubagentTarget = "claude" | "cursor" | "codex" | "opencode";

/** Raw source content in the runtime's native subagent format. */
export type NativeSubagentConfig = string;

export type NativeSubagentContent = Partial<Record<NativeSubagentTarget, NativeSubagentConfig>>;

export type SubagentIdentityStrategy =
  | "frontmatter-name"
  | "frontmatter-name-or-filename"
  | "filename"
  | "toml-name";

/**
 * Describes where an agent stores custom subagent definitions.
 */
export interface SubagentConfigSpec {
  /** Project-scope directory, relative to project root */
  projectDir: string;
  /** User-scope directory, absolute path */
  userDir: string;
  /** Generated file extension, including the leading dot */
  fileExtension: ".md" | ".toml";
  /** Runtime-specific rule for identifying a subagent artifact */
  identity: SubagentIdentityStrategy;
  /** Transforms a universal subagent declaration into an agent-specific file */
  serialize: SubagentSerializer;
}

/**
 * Transforms a universal SubagentDeclaration into a runtime-specific file.
 */
export type SubagentSerializer = (subagent: SubagentDeclaration) => {
  fileName: string;
  content: string;
};
