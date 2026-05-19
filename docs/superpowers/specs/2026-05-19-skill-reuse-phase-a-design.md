# Skill Reuse Phase A — Design

**Status**: Approved (brainstorming complete, awaiting plan)
**Date**: 2026-05-19
**Scope**: Phase A only. Phase C (plugin marketplace, namespaced skills, MCP skill, fork mode, `/plugin install`) is explicitly out of scope.

## 1. Motivation

codeshell already has a half-finished skill subsystem (`src/skills/scanner.ts`, `matcher.ts`, `src/tool-system/builtin/skill.ts`, the listing call site in `src/prompt/composer.ts:158-165`). The subsystem does not work for its primary use case — reusing community skill repositories such as `github.com/anthropics/skills` or `github.com/obra/superpowers` — because:

1. `scanner.ts:59` only reads flat `.md` files in the skills directory. Every community repo uses `<base>/<name>/SKILL.md` subdirectories, so `git clone` produces zero discovered skills.
2. The frontmatter schema (`keywords`, `tools`, `intents`, `when_to_use`) was invented locally and does not match the CC standard (`name`, `description`). Even if the layout were fixed, descriptions from CC-style SKILL.md files would not be read.
3. `src/plugins/loader.ts` exists but has zero call sites — dead code.
4. `skills-builtin/codeshell-help.md` ships one built-in skill in flat-file layout, which contradicts the directory-format decision.

Phase A makes scanner discovery and frontmatter parsing **byte-for-byte compatible with CC's `loadSkillsDir` and `parseFrontmatter`**, so that a user can `cp -r ~/anthropic-skills-clone/skills/pdf ~/.code-shell/skills/pdf` and have `pdf` immediately appear as a usable skill. The installer command (`codeshell skill add`), plugin marketplace, namespaced skills, MCP integration, and dynamic discovery are all deferred to Phase C.

## 2. Alignment Matrix with Claude Code

| Dimension | CC behavior | Phase A behavior | Aligned? |
|---|---|---|---|
| Directory layout | `<base>/<name>/SKILL.md`, strict one level | Same | Yes |
| Frontmatter parse | Regex split + `yaml` package + `quoteProblematicValues` retry + `coerceDescription` | Identical pipeline | Yes |
| Name authority | Directory name wins; `frontmatter.name` validated only | Same | Yes |
| Memoization | `getSkillToolCommands` memoized by cwd | `scanSkills` memoized via lodash-es | Yes |
| SkillTool re-scan | Never; uses cached `getCommands` | Never; uses `scanSkills` cache | Yes |
| Listing layering | Data layer (`commands.ts`) + render layer (`tools/SkillTool/prompt.ts`) | Same split: `scanner.ts` + `skill-prompt.ts` | Yes |
| Error policy | Never throws; warns and skips | Same | Yes |
| `/skills` UI | Full-screen Dialog grouped by source | Text grouped by source | Behavior aligned, UI simplified |
| `Skill` tool schema | `{skill, args}` + inline/fork output | `{skill, args}` + inline only | inline aligned, fork deferred to Phase C |

Items explicitly **not** aligned in Phase A (all deferred to Phase C): plugin system, namespaced skill names (`plugin:skill`), MCP skill registration, bundled skill registry, dynamic discovery on file ops, permission dialog, fork execution, `/plugin install` command.

## 3. Architecture

### 3.1 File changes

```
src/skills/
  scanner.ts                ← rewrite; export memoized scanSkills + SkillDefinition
  matcher.ts                ← delete
  index.ts                  ← export scanSkills + SkillDefinition; drop matcher exports

src/tool-system/builtin/
  skill.ts                  ← call scanSkills(); delete inline readdir block
  skill-prompt.ts (new)     ← buildSkillListing(skills): string

src/prompt/composer.ts:158-165
                            ← import path → skill-prompt.ts; body unchanged

src/cli/commands/builtin/extra-commands.ts:155-177
                            ← /skills output grouped by source

src/index.ts:148-149
                            ← drop matcher exports + MatchResult type; keep scanSkills + SkillDefinition

skills-builtin/             ← delete entire directory
package.json (files array)  ← remove "skills-builtin"

tests/skills.test.ts        ← rewrite; drop matcher cases; add subdir + frontmatter + memo cases
```

### 3.2 Public API surface

```ts
// src/skills/scanner.ts (and re-exported via src/skills/index.ts)
export interface SkillDefinition {
  name: string;          // directory name; authoritative
  description: string;   // from frontmatter.description, coerced; "" if absent/invalid
  content: string;       // SKILL.md body, frontmatter stripped
  filePath: string;      // absolute path to SKILL.md
  source: "project" | "user";
}

export const scanSkills: (cwd: string) => SkillDefinition[];
export function invalidateSkillCache(): void;

// src/tool-system/builtin/skill-prompt.ts
export function buildSkillListing(skills: SkillDefinition[]): string;
```

`SkillDefinition` is a breaking shape change vs. the old export (`triggers`, `whenToUse` removed; `source` added). The matcher exports (`matchSkillsByInput`, `matchSkillsByTool`, `MatchResult`) are removed entirely. Listed under §7 (breaking changes).

### 3.3 Frontmatter parsing pipeline

Lifted from CC `utils/frontmatterParser.ts:130-175`:

```
parseFrontmatter(raw):
  regex = /^---\s*\n([\s\S]*?)---\s*\n?/
  m = raw.match(regex)
  if !m: return { frontmatter: {}, body: raw }
  text = m[1]
  body = raw.slice(m[0].length)   // CC does not trim; preserve byte-for-byte
  try: parsed = parseYaml(text)
       if isPlainObject(parsed): return { frontmatter: parsed, body }
  catch:
    try: parsed = parseYaml(quoteProblematicValues(text))
         if isPlainObject(parsed): return { frontmatter: parsed, body }
    catch: log warn (filePath in message); fall through
  return { frontmatter: {}, body }

quoteProblematicValues(text):
  for each line matching /^([a-zA-Z_-]+):\s+(.+)$/:
    if value not already quoted AND value matches /[{}[\]*&#!|>%@`]|: /:
      replace line with `${key}: "${escapedValue}"`
  return joined lines

coerceDescription(v): string
  if v == null: return ""
  if typeof v === "string": return v.trim()
  if typeof v === "number" || typeof v === "boolean": return String(v)
  log warn; return ""   // arrays/objects rejected
```

`parseYaml` is `import { parse } from "yaml"` — `yaml@^2.7.0` is already in `package.json`, no new dependency.

`name` is **always** `entry.name` (the subdirectory name). `frontmatter.name`, if present and mismatched, produces a warning only.

### 3.4 Scan algorithm

```
scanSkills(cwd):  // memoized by cwd
  bases = [
    { dir: join(cwd, ".code-shell", "skills"),     source: "project" },
    { dir: join(homedir(), ".code-shell", "skills"), source: "user" },
  ]
  results = []
  seen = Set<string>()
  for { dir, source } in bases:
    if !existsSync(dir): continue
    try entries = readdirSync(dir, { withFileTypes: true })
    catch (e):
      if EACCES/EPERM: log warn; continue
      else: throw  // unexpected, surfaces in caller
    for entry in entries:
      if !(entry.isDirectory() || entry.isSymbolicLink()): continue
      if seen.has(entry.name): continue   // project precedence
      skillFile = join(dir, entry.name, "SKILL.md")
      try raw = readFileSync(skillFile, "utf-8")
      catch (e):
        if ENOENT: continue silently
        if EACCES/EPERM/EIO: log warn; continue
      { frontmatter, body } = parseFrontmatter(raw, skillFile)
      if frontmatter.name && frontmatter.name !== entry.name:
        log warn  // directory name wins
      description = coerceDescription(frontmatter.description)
      results.push({ name: entry.name, description, content: body, filePath: skillFile, source })
      seen.add(entry.name)
  return results
```

Memoization is via `lodash-es` `memoize(fn)` keyed on `cwd`. `invalidateSkillCache()` calls `scanSkills.cache.clear()` — exported for a future `/reload` command but unused in Phase A.

### 3.5 SkillTool integration

`src/tool-system/builtin/skill.ts` becomes:

```ts
export async function skillTool(args: Record<string, unknown>): Promise<string> {
  const skillName = args.skill as string;
  const skillArgs = (args.args as string) ?? "";
  if (!skillName) return "Error: skill name is required.";
  const skills = scanSkills(process.cwd());
  const found = skills.find(s => s.name === skillName);
  if (!found) {
    return `Skill "${skillName}" not found. Run /skills to list available skills.`;
  }
  return found.content
    .replace(/\$ARGUMENTS/g, skillArgs)
    .replace(/\{args\}/g, skillArgs);
}
```

The `Skill "${name}" loaded:\n\n` prefix from the current implementation is dropped — CC returns body directly so the model treats it as a direct instruction. `$ARGUMENTS` and `{args}` substitutions are both preserved (the current code supports both).

### 3.6 `/skills` command

```
no skills:
  "No skills found.\n" +
  "Create skills in:\n" +
  "  .code-shell/skills/<name>/SKILL.md   (project)\n" +
  "  ~/.code-shell/skills/<name>/SKILL.md  (user)"

with skills:
  group by source, project first
  for each non-empty group:
    "{Capitalized source} skills ({count}):"
    "  {name} — {description || '(no description)'}"
  blank line between groups
```

### 3.7 Listing in system prompt

`buildSkillListing(skills: SkillDefinition[]): string` (in `skill-prompt.ts`) returns:

```
# Available Skills

- name1: description1
- name2: description2
```

Empty string if `skills.length === 0`. No token budget logic yet — that lands with Phase C.

## 4. Data Flow

**Session start (cold):**

PromptComposer builds the `skills` section → `scanSkills(cwd)` (cache miss) → walks two bases, reads SKILL.md files, parses frontmatter, populates cache → `buildSkillListing` renders the list → string is concatenated into the system prompt.

**Model invokes `Skill(skill: "pdf")` (hot):**

`skillTool(args)` → `scanSkills(cwd)` (cache hit, zero IO) → `find(s => s.name === "pdf")` → body returned as tool_result with `$ARGUMENTS` substituted → model treats body as new instructions in the next turn.

**User runs `/skills`:**

`scanSkills(cwd)` (cache hit) → `groupBy(skills, "source")` → `ctx.addStatus(formatted)`.

## 5. Error Handling

| Failure | Handling |
|---|---|
| Scan dir missing | Silently skip |
| Scan dir EACCES/EPERM | warn once, skip base |
| Subdir without SKILL.md | Silently skip |
| SKILL.md EACCES/EPERM/EIO | warn once, skip skill |
| YAML parse fails (both attempts) | warn once with filePath, register skill with empty description |
| `frontmatter.name` mismatches directory name | warn once, directory name wins |
| `description` is array/object | warn once, description = `""` |
| Same name in project and user | project wins, user version skipped silently |
| `skillTool` invoked with unknown name | Return error string as tool_result |

Principle: **never throw**. A broken skill must not poison the session. Sources: CC `loadSkillsDir.ts:436-444`, `frontmatterParser.ts:162-168`, `coerceDescriptionToString` log behavior at `:319-324`.

## 6. Testing

Rewrite `tests/skills.test.ts`. Target: 100% line coverage on `scanner.ts`, `skill-prompt.ts`, and the rewritten `skill.ts`. Approximate count: 25 cases.

```
scanSkills - directory layout
  - discovers <user>/<name>/SKILL.md
  - discovers <project>/<name>/SKILL.md
  - project skill shadows same-named user skill
  - skips subdirectory missing SKILL.md
  - ignores flat .md files in base dir (no longer supported)
  - follows symlinked directory
  - returns [] when base dir is absent

scanSkills - frontmatter
  - parses name + description
  - empty frontmatter → description ""
  - description as multiline yaml literal (>) preserved
  - description with glob specials (**/*.{ts,tsx}) parsed via quoteProblematicValues
  - description as number → coerced to string
  - description as array → "" + warn
  - completely malformed yaml → empty frontmatter, no throw
  - directory name authoritative when frontmatter.name differs (warn)

scanSkills - memoization
  - second call with same cwd does no IO (mock fs counter)
  - invalidateSkillCache() forces re-scan

buildSkillListing
  - empty input → ""
  - non-empty → "- name: description\n..."
  - missing description → "- name: " (CC parity)

skillTool integration
  - returns markdown body when skill exists
  - returns error string when skill missing
  - $ARGUMENTS substitution
  - {args} substitution (legacy alias)

/skills command
  - empty state message
  - groups output by source, project first
```

## 7. Breaking Changes

External SDK consumers of `@cjhyy/code-shell` lose:

- `matchSkillsByInput`, `matchSkillsByTool` — function exports
- `MatchResult` — type export
- `SkillDefinition.triggers`, `SkillDefinition.whenToUse` — field exports

Internal users (project skills, user skills) lose: flat `.md` discovery. A skill currently sitting at `~/.code-shell/skills/foo.md` will not be discovered after Phase A. The fix is `mkdir foo && mv foo.md foo/SKILL.md`. This is mentioned in the changelog.

Rationale for accepting these breaks: the matcher API was implemented but never used by codeshell itself (zero internal call sites verified by grep), and the flat layout cannot coexist with CC-standard subdirectory layout without surface-area-doubling code. Users with no published SDK consumers and no flat-layout skills are unaffected.

## 8. Out of Scope (Phase C)

- `codeshell skill add <git-url>` installer
- `~/.code-shell/installed.json` skill manifest
- Plugin marketplace (`/plugin install`, `installed_plugins.json`)
- Namespaced skill names (`plugin:skill-name`)
- MCP skill registration
- Bundled skill registry (`registerBundledSkill`)
- Dynamic discovery on file operations
- `SkillPermissionRequest` dialog
- `context: fork` execution mode
- Token budget pruning in `buildSkillListing`
