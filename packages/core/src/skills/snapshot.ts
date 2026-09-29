/** Read-only Skill snapshots for trusted capability packages. */
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { parseFrontmatter } from "./frontmatter.js";
import { readBoundedSkillFile, readSkillBundle, validateSkillMarkdown } from "./management.js";
import { scanSkills, type SkillDefinition } from "./scanner.js";

export interface SkillSnapshot {
  name: string;
  source: SkillDefinition["source"];
  filePath: string;
  /** Full SKILL.md text, frontmatter included. */
  markdown: string;
  frontmatter: Record<string, unknown>;
  /** SKILL.md with the frontmatter block removed. */
  body: string;
  revision: string;
  /** Whether the revision covers the full bundle or only the validated markdown. */
  revisionKind: "bundle" | "markdown";
  /** Bundle files other than SKILL.md; null when the bundle cannot be read safely. */
  extraFiles: string[] | null;
}

/**
 * Read current on-disk text using the scanner only for discovery. An unmanageable
 * bundle can yield a markdown-only revision, but its SKILL.md must still pass the
 * same no-follow, regular-file, size and markdown checks as managed Skills.
 */
export function readSkillSnapshot(name: string, cwd: string): SkillSnapshot | null {
  const skill = scanSkills(cwd).find((candidate) => candidate.name === name);
  if (!skill) return null;

  let markdown: string;
  let revision: string;
  let revisionKind: SkillSnapshot["revisionKind"];
  let extraFiles: string[] | null;
  try {
    const bundle = readSkillBundle(dirname(skill.filePath));
    markdown = bundle.content;
    revision = bundle.revision;
    revisionKind = "bundle";
    extraFiles = bundle.files.map((file) => file.path).filter((path) => path !== "SKILL.md");
  } catch {
    // Never fall back to the scanner's cached body or an unchecked file read:
    // the bundle failure may have come from an unsafe or malformed SKILL.md.
    markdown = validateSkillMarkdown(readBoundedSkillFile(skill.filePath).toString("utf8"));
    revision = createHash("sha256").update(markdown).digest("hex");
    revisionKind = "markdown";
    extraFiles = null;
  }
  const { frontmatter, body } = parseFrontmatter(markdown);
  return {
    name: skill.name,
    source: skill.source,
    filePath: skill.filePath,
    markdown,
    frontmatter,
    body,
    revision,
    revisionKind,
    extraFiles,
  };
}
