import { basename, extname } from "node:path";
import { parse as parseTOML } from "smol-toml";
import { parseMarkdownFrontmatterContent } from "@sentry/dotagents-lib";
import type { SubagentConfigSpec, SubagentIdentityStrategy } from "./types.js";

export function subagentIdentityFromMarkdownMeta(
  strategy: SubagentIdentityStrategy,
  fileName: string | undefined,
  meta: Record<string, unknown>,
): string | null {
  const declaredName = typeof meta["name"] === "string" && meta["name"] ? meta["name"] : null;

  switch (strategy) {
    case "frontmatter-name":
      return declaredName;
    case "frontmatter-name-or-filename":
      return declaredName ?? (fileName ? subagentIdentityFromFileName(fileName) : null);
    case "filename":
      return fileName ? subagentIdentityFromFileName(fileName) : null;
    case "toml-name":
      return null;
  }
}

export function generatedSubagentIdentity(
  spec: SubagentConfigSpec,
  fileName: string,
  content: string,
  portableName: string,
): string | null {
  switch (spec.identity) {
    case "frontmatter-name":
    case "frontmatter-name-or-filename":
      return portableName;
    case "filename":
      return subagentIdentityFromFileName(fileName);
    case "toml-name":
      return subagentIdentityFromTomlContent(content);
  }
}

export function readSubagentFileIdentity(
  spec: SubagentConfigSpec,
  filePath: string,
  fileName: string,
  content: string,
): string | null {
  switch (spec.identity) {
    case "frontmatter-name":
    case "frontmatter-name-or-filename": {
      try {
        const { meta } = parseMarkdownFrontmatterContent(content, filePath);
        return subagentIdentityFromMarkdownMeta(spec.identity, fileName, meta);
      } catch {
        return null;
      }
    }
    case "filename":
      return subagentIdentityFromFileName(fileName);
    case "toml-name":
      return subagentIdentityFromTomlContent(content);
  }
}

export function subagentIdentityFromTomlContent(content: string): string | null {
  try {
    const parsed = parseTOML(content);
    if (isPlainObject(parsed) && typeof parsed["name"] === "string" && parsed["name"]) {
      return parsed["name"];
    }
  } catch {
    return null;
  }
  return null;
}

function subagentIdentityFromFileName(fileName: string): string {
  return basename(fileName, extname(fileName));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
