# Skill Reuse Phase A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make codeshell's skill scanner load `<base>/<name>/SKILL.md` files compatible with Claude Code's loader, so users can drop in any community SKILL.md (e.g. from `github.com/anthropics/skills`) and have it work.

**Architecture:** Rewrite `src/skills/scanner.ts` to walk subdirectories and parse frontmatter via the `yaml` package (with `quoteProblematicValues` retry and `coerceDescription`). Delete `matcher.ts` and the `skills-builtin/` directory. Move skill listing to a new `src/tool-system/builtin/skill-prompt.ts`. Rewrite `skillTool` to reuse memoized `scanSkills` instead of doing its own readdir. Output of `/skills` becomes grouped by source.

**Tech Stack:** TypeScript (ESM), bun runtime, bun:test test runner, `yaml@^2.7.0` (already a dep), `lodash-es@^4.17.23` (already a dep).

**Reference spec:** `docs/superpowers/specs/2026-05-19-skill-reuse-phase-a-design.md`

**Reference Claude Code source files** (read-only, for parity):
- `~/Documents/个人学习/代码学习/claude-code-sourcemap/restored-src/src/utils/frontmatterParser.ts`
- `~/Documents/个人学习/代码学习/claude-code-sourcemap/restored-src/src/skills/loadSkillsDir.ts`
- `~/Documents/个人学习/代码学习/claude-code-sourcemap/restored-src/src/tools/SkillTool/SkillTool.ts`

---

## File Map

**Create:**
- `src/skills/frontmatter.ts` — `parseFrontmatter`, `quoteProblematicValues`, `coerceDescription` (CC parity helpers)
- `src/tool-system/builtin/skill-prompt.ts` — `buildSkillListing(skills)` renderer
- `tests/skills-scanner.test.ts` — scanner + frontmatter coverage
- `tests/skills-tool.test.ts` — `skillTool` integration coverage
- `tests/skills-listing.test.ts` — `buildSkillListing` coverage

**Modify:**
- `src/skills/scanner.ts` — full rewrite, memoized scanSkills with subdir layout
- `src/skills/index.ts` — drop matcher exports, drop MatchResult type
- `src/tool-system/builtin/skill.ts` — call scanSkills, drop inline readdir
- `src/prompt/composer.ts:13,158-165` — import path to `skill-prompt.ts`
- `src/cli/commands/builtin/extra-commands.ts:155-177` — group `/skills` output by source
- `src/index.ts:146-149` — drop matcher exports
- `package.json` — remove `"skills-builtin"` from `files` array

**Delete:**
- `src/skills/matcher.ts`
- `skills-builtin/` (entire directory)
- `tests/skills.test.ts` (replaced by three new tests files)

---

## Pre-flight

- [ ] **Step 0.1: Verify clean tree and on `main` branch**

Run: `git status && git rev-parse --abbrev-ref HEAD`
Expected: tree clean, branch `main`.

- [ ] **Step 0.2: Verify test runner works baseline**

Run: `bun test tests/skills.test.ts 2>&1 | tail -20`
Expected: tests run (may have failures from current state — that's fine, we'll replace them).

- [ ] **Step 0.3: Snapshot current behavior we are deliberately breaking**

Note these breakages for the future changelog entry (do not commit anything yet):
- Flat `~/.code-shell/skills/foo.md` files will no longer be discovered.
- SDK exports `matchSkillsByInput`, `matchSkillsByTool`, `MatchResult`, `SkillDefinition.triggers`, `SkillDefinition.whenToUse` will be removed.

---

## Task 1: New frontmatter helpers (TDD, CC-parity)

**Files:**
- Create: `src/skills/frontmatter.ts`
- Test: `tests/skills-scanner.test.ts` (frontmatter section)

These helpers are pure functions with no filesystem dependency. Writing them first makes Task 2 (scanner) trivial.

- [ ] **Step 1.1: Create test file with frontmatter cases**

Create `tests/skills-scanner.test.ts` (new file) with frontmatter coverage only. Body:

```ts
import { describe, it, expect } from "bun:test";
import {
  parseFrontmatter,
  quoteProblematicValues,
  coerceDescription,
} from "../src/skills/frontmatter.js";

describe("parseFrontmatter", () => {
  it("parses standard name + description", () => {
    const raw = "---\nname: foo\ndescription: does things\n---\nbody here";
    const { frontmatter, body } = parseFrontmatter(raw);
    expect(frontmatter.name).toBe("foo");
    expect(frontmatter.description).toBe("does things");
    expect(body).toBe("body here");
  });

  it("returns empty frontmatter and full body when no delimiters", () => {
    const raw = "just markdown here";
    const { frontmatter, body } = parseFrontmatter(raw);
    expect(frontmatter).toEqual({});
    expect(body).toBe("just markdown here");
  });

  it("handles multi-line description via yaml literal block (>)", () => {
    const raw = "---\ndescription: >\n  line one\n  line two\n---\nbody";
    const { frontmatter } = parseFrontmatter(raw);
    expect(frontmatter.description).toMatch(/line one line two/);
  });

  it("recovers via quoteProblematicValues when description contains glob specials", () => {
    const raw = "---\nname: gl\ndescription: Use for **/*.{ts,tsx} patterns\n---\nbody";
    const { frontmatter } = parseFrontmatter(raw);
    expect(frontmatter.name).toBe("gl");
    expect(frontmatter.description).toContain("**/*.{ts,tsx}");
  });

  it("returns empty frontmatter (no throw) when yaml is completely broken", () => {
    const raw = "---\n: : : invalid : : :\n  bad indent\n---\nbody";
    const { frontmatter, body } = parseFrontmatter(raw);
    expect(frontmatter).toEqual({});
    expect(body).toBe("body");
  });

  it("does not trim leading newlines from body (CC parity)", () => {
    const raw = "---\nname: foo\n---\n\nbody starts here";
    const { body } = parseFrontmatter(raw);
    expect(body.startsWith("\nbody starts here") || body === "\nbody starts here").toBe(true);
  });
});

describe("quoteProblematicValues", () => {
  it("quotes unquoted value with glob specials", () => {
    const input = "key: foo/*.{ts,tsx}";
    const output = quoteProblematicValues(input);
    expect(output).toBe('key: "foo/*.{ts,tsx}"');
  });

  it("leaves already-quoted values alone", () => {
    const input = 'key: "already quoted"';
    expect(quoteProblematicValues(input)).toBe(input);
  });

  it("leaves plain values alone", () => {
    const input = "key: plain value";
    expect(quoteProblematicValues(input)).toBe(input);
  });

  it("escapes embedded double quotes when wrapping", () => {
    const input = 'key: has "quotes" and *';
    const output = quoteProblematicValues(input);
    expect(output).toBe('key: "has \\"quotes\\" and *"');
  });
});

describe("coerceDescription", () => {
  it("trims string descriptions", () => {
    expect(coerceDescription("  hello  ")).toBe("hello");
  });

  it("returns empty string for null/undefined", () => {
    expect(coerceDescription(null)).toBe("");
    expect(coerceDescription(undefined)).toBe("");
  });

  it("stringifies numbers and booleans", () => {
    expect(coerceDescription(42)).toBe("42");
    expect(coerceDescription(true)).toBe("true");
  });

  it("returns empty string for arrays and objects", () => {
    expect(coerceDescription(["a", "b"])).toBe("");
    expect(coerceDescription({ a: 1 })).toBe("");
  });
});
```

- [ ] **Step 1.2: Run new test, expect failures**

Run: `bun test tests/skills-scanner.test.ts 2>&1 | tail -10`
Expected: FAIL with "Cannot find module" for `../src/skills/frontmatter.js`.

- [ ] **Step 1.3: Implement `src/skills/frontmatter.ts`**

Create `src/skills/frontmatter.ts`:

```ts
/**
 * Frontmatter parser for SKILL.md files. Byte-compatible with Claude Code's
 * `utils/frontmatterParser.ts` so community skill repositories can be reused
 * without modification.
 */

import { parse as parseYaml } from "yaml";

export const FRONTMATTER_REGEX = /^---\s*\n([\s\S]*?)---\s*\n?/;

const YAML_SPECIAL_CHARS = /[{}[\]*&#!|>%@`]|: /;

export interface ParsedFrontmatter {
  frontmatter: Record<string, unknown>;
  body: string;
}

export function parseFrontmatter(raw: string): ParsedFrontmatter {
  const match = raw.match(FRONTMATTER_REGEX);
  if (!match) {
    return { frontmatter: {}, body: raw };
  }
  const text = match[1] ?? "";
  const body = raw.slice(match[0].length);

  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch {
    try {
      parsed = parseYaml(quoteProblematicValues(text));
    } catch {
      return { frontmatter: {}, body };
    }
  }

  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return { frontmatter: parsed as Record<string, unknown>, body };
  }
  return { frontmatter: {}, body };
}

export function quoteProblematicValues(frontmatterText: string): string {
  const lines = frontmatterText.split("\n");
  const result: string[] = [];

  for (const line of lines) {
    const m = line.match(/^([a-zA-Z_-]+):\s+(.+)$/);
    if (!m) {
      result.push(line);
      continue;
    }
    const key = m[1];
    const value = m[2];
    if (!key || !value) {
      result.push(line);
      continue;
    }
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      result.push(line);
      continue;
    }
    if (YAML_SPECIAL_CHARS.test(value)) {
      const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      result.push(`${key}: "${escaped}"`);
      continue;
    }
    result.push(line);
  }

  return result.join("\n");
}

export function coerceDescription(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}
```

- [ ] **Step 1.4: Run tests, expect pass**

Run: `bun test tests/skills-scanner.test.ts 2>&1 | tail -10`
Expected: all frontmatter tests PASS.

- [ ] **Step 1.5: Commit**

```bash
git add src/skills/frontmatter.ts tests/skills-scanner.test.ts
git commit -m "$(cat <<'EOF'
feat(skills): add CC-compatible frontmatter parser

Splits SKILL.md into frontmatter + body via the yaml package, with a
quoteProblematicValues retry for glob-style values and a coerceDescription
helper that mirrors Claude Code's behavior at utils/frontmatterParser.ts.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Rewrite scanner with subdirectory layout + memoization

**Files:**
- Modify: `src/skills/scanner.ts` (full rewrite)
- Test: `tests/skills-scanner.test.ts` (append scanner cases)

- [ ] **Step 2.1: Append scanner test cases to `tests/skills-scanner.test.ts`**

First update the top-of-file `bun:test` import to include the lifecycle hooks. Change line 1 from:

```ts
import { describe, it, expect } from "bun:test";
```
to:
```ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
```

Then append the following at the end of `tests/skills-scanner.test.ts`:

```ts
import { scanSkills, invalidateSkillCache } from "../src/skills/scanner.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function makeSkillDir(base: string, name: string, frontmatter: string, body: string) {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n${body}`);
  return dir;
}

describe("scanSkills - directory layout", () => {
  let projectRoot: string;
  let originalHome: string | undefined;
  let fakeHome: string;

  beforeEach(() => {
    invalidateSkillCache();
    projectRoot = mkdtempSync(join(tmpdir(), "skills-proj-"));
    fakeHome = mkdtempSync(join(tmpdir(), "skills-home-"));
    originalHome = process.env.HOME;
    process.env.HOME = fakeHome;
  });

  afterEach(() => {
    invalidateSkillCache();
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
  });

  it("discovers <user>/<name>/SKILL.md", () => {
    const userBase = join(fakeHome, ".code-shell", "skills");
    makeSkillDir(userBase, "pdf", "name: pdf\ndescription: handle PDFs", "PDF body");
    const skills = scanSkills(projectRoot);
    const pdf = skills.find((s) => s.name === "pdf");
    expect(pdf).toBeDefined();
    expect(pdf!.description).toBe("handle PDFs");
    expect(pdf!.source).toBe("user");
    expect(pdf!.content).toBe("PDF body");
  });

  it("discovers <project>/<name>/SKILL.md", () => {
    const projBase = join(projectRoot, ".code-shell", "skills");
    makeSkillDir(projBase, "deploy", "name: deploy\ndescription: deployment helper", "deploy body");
    const skills = scanSkills(projectRoot);
    const dep = skills.find((s) => s.name === "deploy");
    expect(dep).toBeDefined();
    expect(dep!.source).toBe("project");
  });

  it("project skill shadows user skill of the same name", () => {
    makeSkillDir(join(fakeHome, ".code-shell", "skills"), "shared", "description: from user", "user body");
    makeSkillDir(join(projectRoot, ".code-shell", "skills"), "shared", "description: from project", "project body");
    const skills = scanSkills(projectRoot);
    const matches = skills.filter((s) => s.name === "shared");
    expect(matches).toHaveLength(1);
    expect(matches[0].source).toBe("project");
    expect(matches[0].description).toBe("from project");
  });

  it("skips subdirectory missing SKILL.md", () => {
    const userBase = join(fakeHome, ".code-shell", "skills");
    mkdirSync(join(userBase, "empty"), { recursive: true });
    const skills = scanSkills(projectRoot);
    expect(skills.find((s) => s.name === "empty")).toBeUndefined();
  });

  it("ignores flat .md files in base dir (subdir-only)", () => {
    const userBase = join(fakeHome, ".code-shell", "skills");
    mkdirSync(userBase, { recursive: true });
    writeFileSync(join(userBase, "loose.md"), "---\nname: loose\n---\nbody");
    const skills = scanSkills(projectRoot);
    expect(skills.find((s) => s.name === "loose")).toBeUndefined();
  });

  it("follows symlinked directories", () => {
    const userBase = join(fakeHome, ".code-shell", "skills");
    mkdirSync(userBase, { recursive: true });
    const realDir = mkdtempSync(join(tmpdir(), "real-skill-"));
    writeFileSync(join(realDir, "SKILL.md"), "---\ndescription: linked\n---\nbody");
    symlinkSync(realDir, join(userBase, "linked"));
    const skills = scanSkills(projectRoot);
    expect(skills.find((s) => s.name === "linked")).toBeDefined();
    rmSync(realDir, { recursive: true, force: true });
  });

  it("returns [] when no base dirs exist", () => {
    const skills = scanSkills(projectRoot);
    expect(skills).toEqual([]);
  });

  it("uses directory name as authoritative skill name (frontmatter.name mismatched)", () => {
    const userBase = join(fakeHome, ".code-shell", "skills");
    makeSkillDir(userBase, "actual-name", "name: different-name\ndescription: x", "body");
    const skills = scanSkills(projectRoot);
    expect(skills.find((s) => s.name === "actual-name")).toBeDefined();
    expect(skills.find((s) => s.name === "different-name")).toBeUndefined();
  });

  it("registers skill with empty description when frontmatter is missing", () => {
    const userBase = join(fakeHome, ".code-shell", "skills");
    mkdirSync(join(userBase, "raw"), { recursive: true });
    writeFileSync(join(userBase, "raw", "SKILL.md"), "no frontmatter just body");
    const skills = scanSkills(projectRoot);
    const raw = skills.find((s) => s.name === "raw");
    expect(raw).toBeDefined();
    expect(raw!.description).toBe("");
    expect(raw!.content).toBe("no frontmatter just body");
  });
});

describe("scanSkills - memoization", () => {
  let projectRoot: string;
  let fakeHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    invalidateSkillCache();
    projectRoot = mkdtempSync(join(tmpdir(), "skills-memo-"));
    fakeHome = mkdtempSync(join(tmpdir(), "skills-memo-home-"));
    originalHome = process.env.HOME;
    process.env.HOME = fakeHome;
  });

  afterEach(() => {
    invalidateSkillCache();
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
  });

  it("returns the same array reference on the second call for the same cwd", () => {
    makeSkillDir(join(fakeHome, ".code-shell", "skills"), "cached", "description: c", "b");
    const a = scanSkills(projectRoot);
    const b = scanSkills(projectRoot);
    expect(a).toBe(b);
  });

  it("invalidateSkillCache forces a re-scan that picks up new skills", () => {
    const userBase = join(fakeHome, ".code-shell", "skills");
    makeSkillDir(userBase, "first", "description: 1", "b");
    const before = scanSkills(projectRoot);
    expect(before.find((s) => s.name === "second")).toBeUndefined();

    makeSkillDir(userBase, "second", "description: 2", "b");
    const stillCached = scanSkills(projectRoot);
    expect(stillCached.find((s) => s.name === "second")).toBeUndefined();

    invalidateSkillCache();
    const fresh = scanSkills(projectRoot);
    expect(fresh.find((s) => s.name === "second")).toBeDefined();
  });
});
```

- [ ] **Step 2.2: Run tests, expect compilation failures**

Run: `bun test tests/skills-scanner.test.ts 2>&1 | tail -10`
Expected: FAIL — `invalidateSkillCache` and new `SkillDefinition` shape don't yet exist, plus old scanner still has flat-file fallback that will misbehave.

- [ ] **Step 2.3: Rewrite `src/skills/scanner.ts`**

Replace the entire contents of `src/skills/scanner.ts` with:

```ts
/**
 * Skill scanner — discovers <base>/<name>/SKILL.md files. Mirrors Claude Code's
 * `loadSkillsFromSkillsDir` (skills/loadSkillsDir.ts:407) so community skill
 * repositories drop in without modification.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import memoize from "lodash-es/memoize.js";
import { parseFrontmatter, coerceDescription } from "./frontmatter.js";

export interface SkillDefinition {
  /** Directory name; authoritative regardless of frontmatter.name. */
  name: string;
  /** From frontmatter.description, coerced. Empty string if absent or invalid. */
  description: string;
  /** SKILL.md body with frontmatter stripped. */
  content: string;
  /** Absolute path to the SKILL.md file. */
  filePath: string;
  /** Where the skill was loaded from. */
  source: "project" | "user";
}

interface ScanBase {
  dir: string;
  source: "project" | "user";
}

function bases(cwd: string): ScanBase[] {
  return [
    { dir: join(cwd, ".code-shell", "skills"), source: "project" },
    { dir: join(homedir(), ".code-shell", "skills"), source: "user" },
  ];
}

function isENOENT(e: unknown): boolean {
  return (
    typeof e === "object" && e !== null && "code" in e && (e as { code?: string }).code === "ENOENT"
  );
}

function isInaccessible(e: unknown): boolean {
  if (typeof e !== "object" || e === null || !("code" in e)) return false;
  const code = (e as { code?: string }).code;
  return code === "EACCES" || code === "EPERM" || code === "EIO";
}

function scanOnce(cwd: string): SkillDefinition[] {
  const results: SkillDefinition[] = [];
  const seen = new Set<string>();

  for (const { dir, source } of bases(cwd)) {
    if (!existsSync(dir)) continue;

    let entries: { name: string; isDirectory: () => boolean; isSymbolicLink: () => boolean }[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      if (isInaccessible(e)) {
        // eslint-disable-next-line no-console
        console.warn(`[skills] cannot read ${dir}: ${(e as Error).message}`);
        continue;
      }
      throw e;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (seen.has(entry.name)) continue;

      const skillFile = join(dir, entry.name, "SKILL.md");
      let raw: string;
      try {
        raw = readFileSync(skillFile, "utf-8");
      } catch (e) {
        if (isENOENT(e)) continue;
        if (isInaccessible(e)) {
          // eslint-disable-next-line no-console
          console.warn(`[skills] cannot read ${skillFile}: ${(e as Error).message}`);
          continue;
        }
        throw e;
      }

      const { frontmatter, body } = parseFrontmatter(raw);
      const fmName = typeof frontmatter.name === "string" ? frontmatter.name : undefined;
      if (fmName !== undefined && fmName !== entry.name) {
        // eslint-disable-next-line no-console
        console.warn(
          `[skills] frontmatter.name "${fmName}" in ${skillFile} does not match directory name "${entry.name}"; using directory name`,
        );
      }
      const description = coerceDescription(frontmatter.description);

      results.push({
        name: entry.name,
        description,
        content: body,
        filePath: skillFile,
        source,
      });
      seen.add(entry.name);
    }
  }

  return results;
}

const memoized = memoize(scanOnce);

export function scanSkills(cwd: string): SkillDefinition[] {
  return memoized(cwd);
}

export function invalidateSkillCache(): void {
  memoized.cache.clear?.();
}
```

- [ ] **Step 2.4: Run scanner tests, expect pass**

Run: `bun test tests/skills-scanner.test.ts 2>&1 | tail -20`
Expected: all tests PASS.

- [ ] **Step 2.5: Run the rest of the suite to catch consumers depending on old SkillDefinition shape**

Run: `bun test 2>&1 | tail -40`
Expected: probably FAILs in `tests/skills.test.ts` (old one — we delete it in Task 3), and possibly type errors. Note what fails — Tasks 3 and 4 will clear them.

- [ ] **Step 2.6: Commit**

```bash
git add src/skills/scanner.ts tests/skills-scanner.test.ts
git commit -m "$(cat <<'EOF'
feat(skills): rewrite scanner for <base>/<name>/SKILL.md layout

Walks user + project skills directories, reads SKILL.md from each
subdirectory only (no more flat .md), parses frontmatter via the new
frontmatter module, and memoizes results per cwd. invalidateSkillCache()
is exported for a future /reload hook.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Delete matcher, prune SDK exports, drop old test file

**Files:**
- Delete: `src/skills/matcher.ts`
- Delete: `tests/skills.test.ts`
- Modify: `src/skills/index.ts`
- Modify: `src/index.ts:146-149`

- [ ] **Step 3.1: Delete `src/skills/matcher.ts`**

Run: `git rm src/skills/matcher.ts`

- [ ] **Step 3.2: Delete the old test file (replaced by skills-scanner.test.ts and the listing/tool files coming up)**

Run: `git rm tests/skills.test.ts`

- [ ] **Step 3.3: Rewrite `src/skills/index.ts`**

Replace the entire contents of `src/skills/index.ts` with:

```ts
/**
 * Skills barrel. Phase A keeps the scanner only. Listing rendering lives in
 * src/tool-system/builtin/skill-prompt.ts so the prompt-formatting layer can
 * grow token-budget logic later without churn here.
 */

export { scanSkills, invalidateSkillCache } from "./scanner.js";
export type { SkillDefinition } from "./scanner.js";
```

- [ ] **Step 3.4: Update `src/index.ts:146-149`**

Open `src/index.ts`. Find the section that starts at line 146 (look for `// ─── Skills ───`). Replace those four lines so the section becomes:

```ts
// ─── Skills ──────────────────────────────────────────────────────

export { scanSkills, invalidateSkillCache } from "./skills/index.js";
export type { SkillDefinition } from "./skills/index.js";
```

This removes the `matchSkillsByInput`, `matchSkillsByTool`, `buildSkillListing`, and `MatchResult` exports.

- [ ] **Step 3.5: Run typecheck to catch dangling references**

Run: `bun tsc --noEmit 2>&1 | tail -30`
Expected: errors in `src/prompt/composer.ts` (still imports `buildSkillListing` from `./skills/index.js`). The composer fix comes in Task 4.

- [ ] **Step 3.6: Commit**

```bash
git add src/skills/index.ts src/index.ts
git commit -m "$(cat <<'EOF'
refactor(skills): drop matcher API and old test file

matchSkillsByInput / matchSkillsByTool / MatchResult were not used
internally and conflicted with Claude Code's design of letting the
model select skills via system-prompt listings. The old skills test
file is replaced by per-component test files added in this series.

BREAKING: SDK consumers of @cjhyy/code-shell lose matchSkillsByInput,
matchSkillsByTool, MatchResult, SkillDefinition.triggers, and
SkillDefinition.whenToUse. SkillDefinition gains source.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: New skill-prompt module + composer rewire

**Files:**
- Create: `src/tool-system/builtin/skill-prompt.ts`
- Create: `tests/skills-listing.test.ts`
- Modify: `src/prompt/composer.ts:13,162-163`

- [ ] **Step 4.1: Write `tests/skills-listing.test.ts`**

Create `tests/skills-listing.test.ts` (new file):

```ts
import { describe, it, expect } from "bun:test";
import { buildSkillListing } from "../src/tool-system/builtin/skill-prompt.js";
import type { SkillDefinition } from "../src/skills/scanner.js";

function skill(over: Partial<SkillDefinition> = {}): SkillDefinition {
  return {
    name: "x",
    description: "desc",
    content: "body",
    filePath: "/tmp/x/SKILL.md",
    source: "user",
    ...over,
  };
}

describe("buildSkillListing", () => {
  it("returns empty string for empty input", () => {
    expect(buildSkillListing([])).toBe("");
  });

  it("renders skills as `- name: description` lines under a header", () => {
    const out = buildSkillListing([
      skill({ name: "pdf", description: "handle PDFs" }),
      skill({ name: "deploy", description: "deploy stuff" }),
    ]);
    expect(out).toContain("# Available Skills");
    expect(out).toContain("- pdf: handle PDFs");
    expect(out).toContain("- deploy: deploy stuff");
  });

  it("renders skill with no description as `- name:`", () => {
    const out = buildSkillListing([skill({ name: "bare", description: "" })]);
    expect(out).toContain("- bare:");
  });
});
```

- [ ] **Step 4.2: Run test, expect import failure**

Run: `bun test tests/skills-listing.test.ts 2>&1 | tail -5`
Expected: FAIL — module `skill-prompt.js` not found.

- [ ] **Step 4.3: Create `src/tool-system/builtin/skill-prompt.ts`**

```ts
/**
 * Skill listing renderer for the system prompt. Mirrors Claude Code's split
 * between scan/data layer (skills/scanner.ts) and render layer (this file),
 * matching tools/SkillTool/prompt.ts in CC.
 */

import type { SkillDefinition } from "../../skills/scanner.js";

export function buildSkillListing(skills: SkillDefinition[]): string {
  if (skills.length === 0) return "";
  const lines = skills.map((s) =>
    s.description ? `- ${s.name}: ${s.description}` : `- ${s.name}:`,
  );
  return `# Available Skills\n\n${lines.join("\n")}`;
}
```

- [ ] **Step 4.4: Run listing test, expect pass**

Run: `bun test tests/skills-listing.test.ts 2>&1 | tail -10`
Expected: PASS.

- [ ] **Step 4.5: Update `src/prompt/composer.ts:13 and 162-163`**

In `src/prompt/composer.ts`:

Replace line 13:
```ts
import { scanSkills, buildSkillListing } from "../skills/index.js";
```
with:
```ts
import { scanSkills } from "../skills/index.js";
import { buildSkillListing } from "../tool-system/builtin/skill-prompt.js";
```

Lines 162-163 should already be correct; verify they still read:
```ts
        const skills = scanSkills(this.options.cwd);
        return buildSkillListing(skills);
```

- [ ] **Step 4.6: Typecheck**

Run: `bun tsc --noEmit 2>&1 | tail -20`
Expected: no errors related to `buildSkillListing` or `skills/index.js`. Errors related to the SkillTool inline scanner (in skill.ts) are still possible — those land in Task 5.

- [ ] **Step 4.7: Commit**

```bash
git add src/tool-system/builtin/skill-prompt.ts tests/skills-listing.test.ts src/prompt/composer.ts
git commit -m "$(cat <<'EOF'
refactor(skills): move buildSkillListing to tool-system/builtin/skill-prompt

Pulls the renderer next to the SkillTool that consumes it, mirroring
Claude Code's tools/SkillTool/prompt.ts. The composer imports from the
new path; the skills barrel no longer carries render logic.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: SkillTool reuses scanSkills

**Files:**
- Modify: `src/tool-system/builtin/skill.ts`
- Create: `tests/skills-tool.test.ts`

- [ ] **Step 5.1: Write `tests/skills-tool.test.ts`**

Create `tests/skills-tool.test.ts` (new file):

```ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { skillTool } from "../src/tool-system/builtin/skill.js";
import { invalidateSkillCache } from "../src/skills/scanner.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("skillTool", () => {
  let fakeHome: string;
  let originalHome: string | undefined;
  let originalCwd: string;

  beforeEach(() => {
    invalidateSkillCache();
    fakeHome = mkdtempSync(join(tmpdir(), "skills-tool-"));
    originalHome = process.env.HOME;
    process.env.HOME = fakeHome;
    originalCwd = process.cwd();
  });

  afterEach(() => {
    invalidateSkillCache();
    process.chdir(originalCwd);
    rmSync(fakeHome, { recursive: true, force: true });
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
  });

  it("returns the SKILL.md body when the skill exists", async () => {
    const dir = join(fakeHome, ".code-shell", "skills", "hello");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "---\ndescription: greets\n---\nHello there");

    const out = await skillTool({ skill: "hello" });
    expect(out).toContain("Hello there");
  });

  it("substitutes $ARGUMENTS in the body", async () => {
    const dir = join(fakeHome, ".code-shell", "skills", "echo");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "---\ndescription: e\n---\nrun: $ARGUMENTS");

    const out = await skillTool({ skill: "echo", args: "world" });
    expect(out).toContain("run: world");
  });

  it("substitutes {args} as a legacy alias", async () => {
    const dir = join(fakeHome, ".code-shell", "skills", "legacy");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "---\ndescription: l\n---\nuse {args}");

    const out = await skillTool({ skill: "legacy", args: "ok" });
    expect(out).toContain("use ok");
  });

  it("returns an error string when the skill is missing", async () => {
    const out = await skillTool({ skill: "nope" });
    expect(out.toLowerCase()).toContain("not found");
  });

  it("returns an error string when skill name is empty", async () => {
    const out = await skillTool({ skill: "" });
    expect(out.toLowerCase()).toContain("required");
  });
});
```

- [ ] **Step 5.2: Run tests, expect failures**

Run: `bun test tests/skills-tool.test.ts 2>&1 | tail -10`
Expected: FAIL — current `skillTool` searches `process.cwd()/.code-shell/skills/*.md` (flat files), so subdirectory skills are invisible. Also returns content prefixed by `Skill "<name>" loaded:\n\n` which the new tests don't expect.

- [ ] **Step 5.3: Rewrite `src/tool-system/builtin/skill.ts`**

Replace the entire contents of `src/tool-system/builtin/skill.ts` with:

```ts
/**
 * SkillTool — load a skill's SKILL.md body and return it as the tool result.
 * The scanner is the single source of truth; this tool never reads the disk
 * directly. Matches Claude Code's tools/SkillTool/SkillTool.ts pattern.
 */

import type { ToolDefinition } from "../../types.js";
import { scanSkills } from "../../skills/scanner.js";

export const skillToolDef: ToolDefinition = {
  name: "Skill",
  description:
    "Execute a skill within the main conversation. Skills provide specialized " +
    "capabilities and domain knowledge. Use this tool with the skill name and " +
    "optional arguments.",
  inputSchema: {
    type: "object",
    properties: {
      skill: {
        type: "string",
        description: "The skill name to invoke (e.g., 'pdf', 'brainstorming')",
      },
      args: {
        type: "string",
        description: "Optional arguments substituted into $ARGUMENTS / {args} placeholders",
      },
    },
    required: ["skill"],
  },
};

export async function skillTool(args: Record<string, unknown>): Promise<string> {
  const skillName = args.skill as string;
  const skillArgs = (args.args as string) ?? "";

  if (!skillName) {
    return "Error: skill name is required.";
  }

  const skills = scanSkills(process.cwd());
  const found = skills.find((s) => s.name === skillName);

  if (!found) {
    return `Skill "${skillName}" not found. Run /skills to list available skills.`;
  }

  return found.content
    .replace(/\$ARGUMENTS/g, skillArgs)
    .replace(/\{args\}/g, skillArgs);
}
```

Note: this drops the `Skill "<name>" loaded:\n\n` prefix on purpose so the body is treated as direct instructions, matching CC's behavior.

- [ ] **Step 5.4: Run skillTool tests, expect pass**

Run: `bun test tests/skills-tool.test.ts 2>&1 | tail -10`
Expected: PASS.

- [ ] **Step 5.5: Run the full test suite**

Run: `bun test 2>&1 | tail -30`
Expected: all skill-related tests pass. If anything else fails, capture the file and investigate (likely unrelated).

- [ ] **Step 5.6: Commit**

```bash
git add src/tool-system/builtin/skill.ts tests/skills-tool.test.ts
git commit -m "$(cat <<'EOF'
refactor(skills): SkillTool reuses memoized scanSkills

Removes the duplicate readdir loop inside skillTool; the scanner is now
the single source of truth for skill discovery. Drops the
\"Skill <name> loaded:\" prefix on the tool result so the body acts as
a direct instruction, matching tools/SkillTool/SkillTool.ts in CC.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Group `/skills` output by source

**Files:**
- Modify: `src/cli/commands/builtin/extra-commands.ts:155-177`

- [ ] **Step 6.1: Read the current `/skills` command**

Run: `sed -n '155,180p' src/cli/commands/builtin/extra-commands.ts`
Confirm it matches the spec's §3.6 starting point (the empty-state message references `.claude/skills/` which we are removing).

The file already imports `scanSkills` at the top (line 10 in the current source), so no new imports are needed.

- [ ] **Step 6.2: Replace the `/skills` command body**

In `src/cli/commands/builtin/extra-commands.ts`, replace the block at lines 155-177 with:

```ts
  {
    name: "/skills",
    group: "config",
    description: "List skills available to the model",
    execute: (_arg, ctx) => {
      try {
        const skills = scanSkills(ctx.cwd);
        if (skills.length === 0) {
          ctx.addStatus(
            "No skills found.\n" +
              "Create skills in:\n" +
              "  .code-shell/skills/<name>/SKILL.md   (project)\n" +
              "  ~/.code-shell/skills/<name>/SKILL.md  (user)",
          );
          return;
        }
        const project = skills.filter((s) => s.source === "project");
        const user = skills.filter((s) => s.source === "user");
        const groups: string[] = [];
        if (project.length > 0) {
          const lines = project.map(
            (s) => `  ${s.name} — ${s.description || "(no description)"}`,
          );
          groups.push(`Project skills (${project.length}):\n${lines.join("\n")}`);
        }
        if (user.length > 0) {
          const lines = user.map(
            (s) => `  ${s.name} — ${s.description || "(no description)"}`,
          );
          groups.push(`User skills (${user.length}):\n${lines.join("\n")}`);
        }
        ctx.addStatus(groups.join("\n\n"));
      } catch (err) {
        ctx.addStatus(`Failed to scan skills: ${(err as Error).message}`);
      }
    },
  },
```

- [ ] **Step 6.3: Smoke test with `bun run`**

Run: `bun tsc --noEmit 2>&1 | tail -5`
Expected: no new errors.

- [ ] **Step 6.4: Run full test suite**

Run: `bun test 2>&1 | tail -20`
Expected: all tests pass.

- [ ] **Step 6.5: Commit**

```bash
git add src/cli/commands/builtin/extra-commands.ts
git commit -m "$(cat <<'EOF'
feat(cli): group /skills output by source

Lists project skills first, then user skills, each with its own header
and count. Empty-state message points users at the new <name>/SKILL.md
subdirectory layout.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Delete `skills-builtin/` and update `package.json`

**Files:**
- Delete: `skills-builtin/` (entire directory)
- Modify: `package.json` (files array)

- [ ] **Step 7.1: Delete the directory**

Run: `git rm -r skills-builtin/`

- [ ] **Step 7.2: Update `package.json`**

The current `"files"` array reads:

```json
  "files": [
    "dist",
    "scripts/check-node.cjs",
    "skills-builtin",
    "README.md",
    "LICENSE",
    "CHANGELOG.md"
  ],
```

Remove the `"skills-builtin"` line so it becomes:

```json
  "files": [
    "dist",
    "scripts/check-node.cjs",
    "README.md",
    "LICENSE",
    "CHANGELOG.md"
  ],
```

- [ ] **Step 7.3: Run full test suite + typecheck**

Run: `bun test 2>&1 | tail -10 && bun tsc --noEmit 2>&1 | tail -5`
Expected: all pass.

- [ ] **Step 7.4: Commit**

```bash
git add skills-builtin package.json
git commit -m "$(cat <<'EOF'
chore(skills): remove bundled skills-builtin directory

The single bundled help skill is replaced by user-supplied skills under
~/.code-shell/skills/. The package no longer ships a skills-builtin/
directory, so it is dropped from package.json files.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: End-to-end smoke + final verification

- [ ] **Step 8.1: Stage a real skill from Claude Code's plugin cache for sanity check**

Run:
```bash
mkdir -p ~/.code-shell/skills && \
  cp -r ~/.claude/plugins/cache/superpowers-dev/superpowers/5.1.0/skills/brainstorming \
        ~/.code-shell/skills/brainstorming
ls ~/.code-shell/skills/brainstorming/SKILL.md
```
Expected: prints the SKILL.md path (a real superpowers skill).

- [ ] **Step 8.2: Run codeshell `/skills` to confirm discovery**

Build and run codeshell briefly to confirm `/skills` lists `brainstorming` under User skills with a non-empty description. This is a manual smoke; if the binary path is `dist/cli/main.js`, run:

```bash
bun run build 2>&1 | tail -5
node dist/cli/main.js --help 2>&1 | head -5     # ensure it boots
```

Then in an interactive codeshell session, type `/skills` and confirm:
- Header `User skills (1):` appears
- Line `  brainstorming — ...` appears with a description that matches the SKILL.md frontmatter

If the binary cannot be exercised in this environment, skip the manual step and document this in the task summary.

- [ ] **Step 8.3: Clean up the sanity-check skill (optional)**

```bash
rm -rf ~/.code-shell/skills/brainstorming
```

- [ ] **Step 8.4: Final test + typecheck sweep**

Run:
```bash
bun test 2>&1 | tail -15
bun tsc --noEmit 2>&1 | tail -10
```
Expected: all green.

- [ ] **Step 8.5: Confirm spec coverage**

Cross-check against the spec's §2 alignment matrix:
- [x] Directory layout `<base>/<name>/SKILL.md` — Task 2
- [x] Frontmatter parser (yaml + quote + coerce) — Task 1
- [x] Directory name authoritative — Task 2 (line `seen.add(entry.name)` after push; frontmatter.name warn-only)
- [x] Memoize — Task 2 (lodash-es memoize)
- [x] SkillTool reuse — Task 5
- [x] Listing split into data/render — Task 4
- [x] `/skills` grouped — Task 6
- [x] Error policy never throws — Tasks 1, 2 (warn + skip)
- [x] Matcher exports removed — Task 3
- [x] `skills-builtin/` deleted + package.json synced — Task 7

If any row is unchecked, add the missing task before finishing.

- [ ] **Step 8.6: Final git log review**

Run: `git log --oneline -10`
Expected: roughly eight feature commits since the spec commit `f960f36`, in plan order.

---

## Notes for the executing engineer

- **Test isolation:** scanner tests overwrite `process.env.HOME`. Always restore it in `afterEach`, otherwise later tests in unrelated files may see a tmpdir as HOME and break.
- **No `process.env.HOME` on Windows:** Bun on Windows uses `USERPROFILE`; this plan targets Darwin/Linux (the project's primary platforms per `Platform: darwin` in the repo context). If Windows support is needed later, parameterize `homedir()` instead of mutating env.
- **`memoize.cache.clear`:** `lodash-es/memoize.js` returns a function with a `cache` property whose `clear` method exists on the default `Map` cache. We use the optional-chained call `?.clear?.()` to stay safe if the cache implementation changes.
- **`process.cwd()` vs ctx.cwd:** the SkillTool intentionally uses `process.cwd()` (matching CC). The `/skills` command uses `ctx.cwd` because the CLI passes it through. Both bottom out in `scanSkills`, which memoizes per `cwd` — different cwd values get separate cache entries, which is the right behavior.
