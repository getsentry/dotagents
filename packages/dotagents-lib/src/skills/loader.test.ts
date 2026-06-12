import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadSkillMd, parseMarkdownFrontmatterContent, SkillLoadError } from "./loader.js";

describe("loadSkillMd", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "dotagents-skill-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true });
  });

  it("parses valid SKILL.md with frontmatter", async () => {
    const skillMd = join(dir, "SKILL.md");
    await writeFile(
      skillMd,
      `---
name: pdf-processing
description: Extract and process PDF documents
license: MIT
---

# PDF Processing

This skill handles PDF files.
`,
    );

    const meta = await loadSkillMd(skillMd);
    expect(meta.name).toBe("pdf-processing");
    expect(meta.description).toBe("Extract and process PDF documents");
    expect(meta["license"]).toBe("MIT");
  });

  it("parses frontmatter with a BOM and spaced opener", async () => {
    const skillMd = join(dir, "SKILL.md");
    await writeFile(
      skillMd,
      `\uFEFF--- \t
name: pdf-processing
description: Extract and process PDF documents
---

# PDF Processing
`,
    );

    const meta = await loadSkillMd(skillMd);
    expect(meta.name).toBe("pdf-processing");
    expect(meta.description).toBe("Extract and process PDF documents");
  });

  it("handles quoted values", async () => {
    const skillMd = join(dir, "SKILL.md");
    await writeFile(
      skillMd,
      `---
name: "my-skill"
description: 'A skill with quoted values'
---

Content.
`,
    );

    const meta = await loadSkillMd(skillMd);
    expect(meta.name).toBe("my-skill");
    expect(meta.description).toBe("A skill with quoted values");
  });

  it("throws SkillLoadError for missing file", async () => {
    await expect(loadSkillMd(join(dir, "nope.md"))).rejects.toThrow(
      SkillLoadError,
    );
    await expect(loadSkillMd(join(dir, "nope.md"))).rejects.toThrow(
      `SKILL.md not found: ${join(dir, "nope.md")}`,
    );
  });

  it("throws SkillLoadError for missing frontmatter", async () => {
    const skillMd = join(dir, "SKILL.md");
    await writeFile(skillMd, "# No frontmatter here\n");

    await expect(loadSkillMd(skillMd)).rejects.toThrow(SkillLoadError);
  });

  it("throws SkillLoadError for missing name", async () => {
    const skillMd = join(dir, "SKILL.md");
    await writeFile(
      skillMd,
      `---
description: No name field
---
`,
    );

    await expect(loadSkillMd(skillMd)).rejects.toThrow(SkillLoadError);
  });

  it("throws SkillLoadError for missing description", async () => {
    const skillMd = join(dir, "SKILL.md");
    await writeFile(
      skillMd,
      `---
name: my-skill
---
`,
    );

    await expect(loadSkillMd(skillMd)).rejects.toThrow(SkillLoadError);
  });

  it("folds multi-line plain scalars with single spaces", async () => {
    const skillMd = join(dir, "SKILL.md");
    await writeFile(
      skillMd,
      `---
name: composition-patterns
description:
  React composition patterns that scale.
  Use when refactoring components with boolean prop proliferation.
---
Content.
`,
    );

    const meta = await loadSkillMd(skillMd);
    expect(meta.description).toBe(
      "React composition patterns that scale. Use when refactoring components with boolean prop proliferation.",
    );
  });

  it("parses nested object frontmatter values", async () => {
    const skillMd = join(dir, "SKILL.md");
    await writeFile(
      skillMd,
      `---
name: with-metadata
description: Has nested metadata
metadata:
  author: vercel
  version: '1.0.0'
---
Content.
`,
    );

    const meta = await loadSkillMd(skillMd);
    expect(meta["metadata"]).toEqual({ author: "vercel", version: "1.0.0" });
  });

  it("parses block scalar frontmatter values that contain separator lines", () => {
    const parsed = parseMarkdownFrontmatterContent(
      `---
name: code-reviewer
description: Review code
dotagents_native:
  codex: |+
    # upstream comment
    ---
    name = "code_reviewer"
---

Review the current diff.
`,
      "subagent.md",
    );

    expect(parsed.meta["dotagents_native"]).toEqual({
      codex: '# upstream comment\n---\nname = "code_reviewer"\n',
    });
    expect(parsed.body).toBe("Review the current diff.");
  });

  it("does not treat separator prefixes as frontmatter delimiters", () => {
    const parsed = parseMarkdownFrontmatterContent(
      `---
name: code-reviewer
description: Review code
---not_a_delimiter: true
---

Review the current diff.
`,
      "subagent.md",
    );

    expect(parsed.meta["---not_a_delimiter"]).toBe(true);
    expect(parsed.body).toBe("Review the current diff.");
  });

  it("parses array frontmatter values", async () => {
    const skillMd = join(dir, "SKILL.md");
    await writeFile(
      skillMd,
      `---
name: with-tags
description: Has tags
tags:
  - frontend
  - react
---
Content.
`,
    );

    const meta = await loadSkillMd(skillMd);
    expect(meta["tags"]).toEqual(["frontend", "react"]);
  });

  it("parses allowed-tools into ToolName array", async () => {
    const skillMd = join(dir, "SKILL.md");
    await writeFile(
      skillMd,
      `---
name: tool-skill
description: Uses allowed-tools
allowed-tools: Read Grep Glob
---
Content.
`,
    );

    const meta = await loadSkillMd(skillMd);
    expect(meta.allowedTools).toEqual(["Read", "Grep", "Glob"]);
  });

  it("warns and drops unknown allowed-tools tokens", async () => {
    const skillMd = join(dir, "SKILL.md");
    await writeFile(
      skillMd,
      `---
name: tool-skill
description: Mixed tools
allowed-tools: Read Magic Grep
---
Content.
`,
    );

    const warnings: string[] = [];
    const meta = await loadSkillMd(skillMd, {
      onWarning: (msg) => warnings.push(msg),
    });

    expect(meta.allowedTools).toEqual(["Read", "Grep"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Magic");
  });

  it("leaves allowedTools undefined when field is absent", async () => {
    const skillMd = join(dir, "SKILL.md");
    await writeFile(
      skillMd,
      `---
name: no-tools
description: No allowed-tools field
---
`,
    );

    const meta = await loadSkillMd(skillMd);
    expect(meta.allowedTools).toBeUndefined();
  });

  it("returns empty array (not undefined) when every token is unrecognized", async () => {
    // A skill that DECLARES allowed-tools but uses unknown names is
    // semantically distinct from a skill that omits the field entirely.
    // Authorization gates that treat undefined as "unrestricted" must be
    // able to see the empty-array signal.
    const skillMd = join(dir, "SKILL.md");
    await writeFile(
      skillMd,
      `---
name: future-tool-skill
description: Uses tools we don't know about yet
allowed-tools: FutureTool AnotherUnknownTool
---
`,
    );

    const warnings: string[] = [];
    const meta = await loadSkillMd(skillMd, { onWarning: (m) => warnings.push(m) });
    expect(meta.allowedTools).toEqual([]);
    expect(warnings).toHaveLength(2);
  });

  it("parses YAML array form of allowed-tools", async () => {
    const skillMd = join(dir, "SKILL.md");
    await writeFile(
      skillMd,
      `---
name: array-tools
description: Uses YAML list syntax
allowed-tools:
  - Read
  - Grep
  - Glob
---
`,
    );

    const meta = await loadSkillMd(skillMd);
    expect(meta.allowedTools).toEqual(["Read", "Grep", "Glob"]);
  });

  it("parses YAML flow-array form of allowed-tools", async () => {
    const skillMd = join(dir, "SKILL.md");
    await writeFile(
      skillMd,
      `---
name: flow-array-tools
description: Uses YAML flow-array syntax
allowed-tools: [Read, Grep, Glob]
---
`,
    );

    const meta = await loadSkillMd(skillMd);
    expect(meta.allowedTools).toEqual(["Read", "Grep", "Glob"]);
  });

  it("preserves empty-array signal: allowed-tools: [] returns []", async () => {
    // Explicit empty YAML array is "deny all" — must NOT collapse to undefined.
    const skillMd = join(dir, "SKILL.md");
    await writeFile(
      skillMd,
      `---
name: deny-all
description: Explicit empty allow-list
allowed-tools: []
---
`,
    );

    const meta = await loadSkillMd(skillMd);
    expect(meta.allowedTools).toEqual([]);
  });

  it("treats empty/whitespace string allowed-tools as absent (likely a typo)", async () => {
    const skillMd = join(dir, "SKILL.md");
    await writeFile(
      skillMd,
      `---
name: empty-string
description: Field present but empty
allowed-tools: "   "
---
`,
    );

    const meta = await loadSkillMd(skillMd);
    expect(meta.allowedTools).toBeUndefined();
  });

  it("warns and skips non-string entries in YAML array", async () => {
    const skillMd = join(dir, "SKILL.md");
    await writeFile(
      skillMd,
      `---
name: bad-array
description: Has non-string entry
allowed-tools:
  - Read
  - 42
  - Grep
---
`,
    );

    const warnings: string[] = [];
    const meta = await loadSkillMd(skillMd, { onWarning: (m) => warnings.push(m) });
    expect(meta.allowedTools).toEqual(["Read", "Grep"]);
    expect(warnings.some((w) => w.includes("non-string"))).toBe(true);
  });

  it("throws SkillLoadError when frontmatter is not a YAML object (e.g. plain string)", async () => {
    const skillMd = join(dir, "SKILL.md");
    await writeFile(
      skillMd,
      `---
just-a-string
---
`,
    );

    await expect(loadSkillMd(skillMd)).rejects.toThrow(SkillLoadError);
  });
});
