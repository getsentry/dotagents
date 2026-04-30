import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadSkillMd, SkillLoadError } from "./loader.js";

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
});
