# skills

**One-line role.** Discovers `SKILL.md` files (from project, user, and installed-plugin directories) and parses their YAML frontmatter into a flat, deduplicated, memoized list of `SkillDefinition`s.

## 职责 / Responsibility

This module owns skill *discovery* and *frontmatter parsing* — nothing more. It walks the well-known skill base directories plus every installed plugin's `skills/` folder, reads each `<name>/SKILL.md`, strips and parses the frontmatter, and returns `SkillDefinition[]`. It deliberately does **not** render the listing for the prompt (that lives in `tool-system/builtin/skill-prompt.ts`) and does **not** decide policy — disabled/allowlist filtering is applied as a thin post-pass over the cached scan. The frontmatter parser is intentionally byte-compatible with Claude Code's parser so community skill repos work unmodified.

## 文件 / Files

| File | Purpose |
| --- | --- |
| `scanner.ts` | Main entry. Discovers skills across project/user/plugin bases, dedupes, memoizes by `cwd + HOME + installedPlugins mtime`, and applies disabled/allowlist filters. Defines `SkillDefinition` and `ScanSkillsOptions`. |
| `frontmatter.ts` | YAML frontmatter parser for `SKILL.md`. `parseFrontmatter` (with a fallback that quotes YAML-special values) and `coerceDescription`. CC-compatible. |
| `index.ts` | Barrel. Re-exports `scanSkills`, `invalidateSkillCache`, and the `SkillDefinition` type. |
| `scanner.allowlist.test.ts` | Tests for the disabled/allowlist filtering behavior. |

## 公开接口 / Public API

Re-exported from the package root (`@code-shell/core`) via `index.ts` → `skills/index.js`:

```ts
interface SkillDefinition {
  name: string;        // directory name; "<plugin>:<name>" for plugin skills. Authoritative over frontmatter.name.
  description: string; // coerced from frontmatter.description; "" if absent/invalid
  content: string;     // SKILL.md body with frontmatter stripped
  filePath: string;    // absolute path to the SKILL.md
  source: "project" | "user" | "plugin";
}

interface ScanSkillsOptions {
  disabledSkills?: string[];   // exact SkillDefinition.name matches (incl. "<plugin>:" prefix)
  disabledPlugins?: string[];  // bare plugin names; drops every "<plugin>:" skill
  skillAllowlist?: string[];   // hard isolation: ONLY these names survive. [] = none; undefined = no filtering
}

function scanSkills(cwd: string, opts?: ScanSkillsOptions): SkillDefinition[];
function invalidateSkillCache(): void;
```

The frontmatter helpers (`parseFrontmatter`, `coerceDescription`, `quoteProblematicValues`, `FRONTMATTER_REGEX`) are *not* in the barrel — they're imported directly from `../skills/frontmatter.js` by `plugins/pluginCommandsLoader.ts` and `plugins/pluginContent.ts`.

## 怎么用 / How to use

Scan with the active session's filters (from `prompt/composer.ts`, building the prompt's skills listing):

```ts
import { scanSkills } from "../skills/index.js";

const skills = scanSkills(this.options.cwd, {
  disabledSkills: this.options.disabledSkills,
  disabledPlugins: this.options.disabledPlugins,
  skillAllowlist: this.options.skillAllowlist, // set for sub-agents to hard-isolate skills
});
return buildSkillListing(skills); // rendering lives elsewhere
```

Resolve one skill by name when the Skill tool is invoked (from `tool-system/builtin/skill.ts`):

```ts
import { scanSkills } from "../../skills/scanner.js";

// scan from the Engine's cwd, not the host process cwd
const skills = scanSkills(ctx?.cwd ?? process.cwd(), { disabledSkills, disabledPlugins, skillAllowlist });
const found = skills.find((s) => s.name === skillName);
```

Enumerate every skill name with no filtering (from `capability-control/disabled-lists.ts`):

```ts
const allSkillNames = scanSkills(cwd).map((s) => s.name);
```

## 注意 / Gotchas

- **Filters never bust the cache.** The scan is memoized on `cwd + HOME + installedPlugins mtime`. `disabledSkills` / `disabledPlugins` / `skillAllowlist` are applied *after* the cached scan returns, so changing them does not force a re-scan. Call `invalidateSkillCache()` after creating/installing/removing a `SKILL.md` so the next scan picks it up (tests rely on this).
- **Directory name wins over `frontmatter.name`.** If frontmatter declares a mismatching `name`, the scanner warns and uses the directory name anyway. Plugin skills are namespaced `<plugin>:<dir>`.
- **Dedup precedence is project → user → plugin.** First base dir to claim a bare name wins (project beats user); plugin skills dedupe separately by their namespaced name. Symlinked base dirs are resolved with `realpathSync` and skipped if already visited.
- **`skillAllowlist: []` means zero skills, `undefined` means no filtering.** Presence is checked with `!== undefined`, not truthiness — an empty array is a meaningful "isolate to nothing" signal for sub-agents.
- **`disabledPlugins` matches on the first colon only** (`indexOf(":")`), since skill names may theoretically contain further colons after the namespace boundary.
- **HOME is read from `process.env.HOME`, not `os.homedir()`.** `homedir()` caches `getpwuid` and ignores later env mutation; the user-skills lookup honors `process.env.HOME` so tests (and shell overrides) can redirect it.
- **Best-effort I/O.** ENOENT base dirs are skipped silently; EACCES/EPERM/EIO are warned and skipped; other errors throw. A skill with unparseable frontmatter still loads with `frontmatter: {}` (empty description), not dropped.
- **ESM.** Imports use `.js` extensions (`./scanner.js` etc.). Pass the **Engine's** `cwd`, not `process.cwd()`, or you'll scan the wrong project.
