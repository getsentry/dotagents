import { describe, it, expect } from "vitest";
import { parseMarkdownFrontmatterContent } from "@sentry/dotagents-lib";
import {
  interpolateEnvRefs,
  interpolateHeaders,
  extractCodexHeaders,
  serializeMarkdownSubagent,
} from "./helpers.js";

const cursorTpl = (k: string) => `\${env:${k}}`;

describe("interpolateEnvRefs", () => {

  it("passes through strings with no refs", () => {
    expect(interpolateEnvRefs("Bearer tok", cursorTpl)).toBe("Bearer tok");
  });

  it("replaces a single ref", () => {
    expect(interpolateEnvRefs("${API_KEY}", cursorTpl)).toBe("${env:API_KEY}");
  });

  it("replaces ref in a mixed string", () => {
    expect(interpolateEnvRefs("Bearer ${TOKEN}", cursorTpl)).toBe("Bearer ${env:TOKEN}");
  });

  it("replaces multiple refs", () => {
    expect(interpolateEnvRefs("${A}:${B}", cursorTpl)).toBe("${env:A}:${env:B}");
  });

  it("ignores non-matching patterns", () => {
    // No braces, empty braces, leading digit, hyphen in name
    for (const s of ["$NOBRACES", "${}", "${123}", "${foo-bar}"]) {
      expect(interpolateEnvRefs(s, cursorTpl)).toBe(s);
    }
  });

  it("replaces underscore-prefixed and numeric-suffixed vars", () => {
    expect(interpolateEnvRefs("${_FOO_2}", cursorTpl)).toBe("${env:_FOO_2}");
  });
});

describe("interpolateHeaders", () => {
  it("transforms all header values", () => {
    const headers = { "X-Key": "${KEY}", "Authorization": "Bearer ${TOKEN}" };
    const result = interpolateHeaders(headers, (k) => `{env:${k}}`);
    expect(result).toEqual({ "X-Key": "{env:KEY}", "Authorization": "Bearer {env:TOKEN}" });
  });

  it("returns undefined for undefined input", () => {
    const noHeaders: Record<string, string> | undefined = undefined;
    expect(interpolateHeaders(noHeaders, (k) => k)).toBeUndefined();
  });
});

describe("extractCodexHeaders", () => {
  it("maps pure env ref to envHttpHeaders", () => {
    const { httpHeaders, envHttpHeaders } = extractCodexHeaders({
      "X-Api-Key": "${GOOGLE_API_KEY}",
    });
    expect(httpHeaders).toBeUndefined();
    expect(envHttpHeaders).toEqual({ GOOGLE_API_KEY: "X-Api-Key" });
  });

  it("keeps static values in httpHeaders", () => {
    const { httpHeaders, envHttpHeaders } = extractCodexHeaders({
      Authorization: "Bearer tok",
    });
    expect(httpHeaders).toEqual({ Authorization: "Bearer tok" });
    expect(envHttpHeaders).toBeUndefined();
  });

  it("keeps mixed values in httpHeaders as literal fallback", () => {
    const { httpHeaders, envHttpHeaders } = extractCodexHeaders({
      Authorization: "Bearer ${TOKEN}",
    });
    expect(httpHeaders).toEqual({ Authorization: "Bearer ${TOKEN}" });
    expect(envHttpHeaders).toBeUndefined();
  });

  it("splits mixed and pure refs correctly", () => {
    const { httpHeaders, envHttpHeaders } = extractCodexHeaders({
      "X-Api-Key": "${API_KEY}",
      Authorization: "Bearer tok",
      "X-Mixed": "prefix ${VAR} suffix",
    });
    expect(envHttpHeaders).toEqual({ API_KEY: "X-Api-Key" });
    expect(httpHeaders).toEqual({
      Authorization: "Bearer tok",
      "X-Mixed": "prefix ${VAR} suffix",
    });
  });

  it("returns empty object for undefined input", () => {
    const noHeaders: Record<string, string> | undefined = undefined;
    expect(extractCodexHeaders(noHeaders)).toEqual({});
  });
});

describe("serializeMarkdownSubagent", () => {
  it("serializes simple frontmatter fields", () => {
    const content = serializeMarkdownSubagent(
      {
        description: "Review code.",
        mode: "subagent",
      },
      "Review the diff.",
    );

    expect(content).toContain('description: "Review code."');
    expect(content).toContain('mode: "subagent"');
    expect(content).toContain("Review the diff.");
  });

  it("serializes nested frontmatter objects using block YAML", () => {
    const content = serializeMarkdownSubagent(
      {
        name: "code-reviewer",
        description: "Review code.",
        dotagents_native: {
          codex: [
            'name = "code_reviewer"',
            'description = "Review code."',
            "",
          ].join("\n"),
        },
      },
      "Review the diff.",
    );

    expect(content).toContain("dotagents_native:\n  codex: |");
    expect(content).not.toContain('dotagents_native: {"codex"');

    const parsed = parseMarkdownFrontmatterContent(content, "subagent.md");
    expect(parsed.meta["dotagents_native"]).toEqual({
      codex: 'name = "code_reviewer"\ndescription = "Review code."\n',
    });
  });
});
