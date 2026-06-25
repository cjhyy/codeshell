# prompt

**One-line role.** Assembles the LLM system prompt and the per-turn user-context message from reusable markdown sections, discovered instruction files (CLAUDE.md/CODESHELL.md), injected memory, and stable personalization fields.

## 职责 / Responsibility

This module owns *system-prompt assembly*. It turns runtime inputs (cwd, model, resolved preset, tool list, user preferences) into two outputs that mirror Claude Code's dual-chain architecture: the **system** string (runtime header + tool listing + behavior sections + skills listing + personalization) and a **userContext** message (CLAUDE.md instructions + memory wrapped in `<system-reminder>`). It also walks the directory tree to discover layered instruction files and caches each section independently so unchanged sections aren't recomputed per turn. It does **not** make LLM calls, manage tool execution, or own the preset/skill/memory data — it composes content those modules produce.

## 文件 / Files

| File | Purpose |
| --- | --- |
| `composer.ts` | `PromptComposer` class — the main entry point. Builds system prompt, system context (git status), and userContext message from `ComposerOptions`. |
| `section-loader.ts` | Loads `sections/*.md` markdown from disk; registry for runtime-registered custom sections. Exports `loadSection`/`loadSections`/`availableSections`/`registerSection`. |
| `section-cache.ts` | `SectionCache` + `PromptSection` type — per-section memoization keyed by section name, with `cacheBreak` opt-out and `invalidate()`. |
| `instruction-scanner.ts` | Discovers layered instruction files (managed/user/project/local) walking from git root down to cwd; `scanInstructions` + `combineInstructions`. |
| `sections/base.md`, `coding.md`, `orchestration.md`, `tone.md` | Built-in behavioral prompt sections; a preset declares which it includes. |
| `sections/md.d.ts` | Ambient `*.md` module declaration (for editor/typecheck; sections are read via `readFileSync`, not imported as modules). |

## 公开接口 / Public API

Re-exported from the package root (`packages/core/src/index.ts`):

```ts
// composer.ts
class PromptComposer {
  constructor(options: ComposerOptions);
  buildSystemPrompt(tools: ToolDefinition[]): Promise<string>;
  buildUserContextMessage(): Message | null;      // CLAUDE.md + memory as <system-reminder>
  buildSystemContext(): Promise<string>;           // git status, only if preset.injectGitStatus
  invalidateCache(sectionName?: string): void;     // drop one or all cached sections
}
interface ComposerOptions {
  cwd: string;
  model: string;
  preset?: AgentPreset;
  customSystemPrompt?: string;
  appendSystemPrompt?: string;
  responseLanguage?: string;        // personalization
  userProfile?: string;             // personalization
  instructionOptions?: ScanOptions;
  disabledSkills?: string[];
  disabledPlugins?: string[];
  skillAllowlist?: string[];        // sub-agent hard isolation
  memoriesMaxAgeDays?: number;
}

// section-cache.ts
class SectionCache { resolve(sections: PromptSection[]): Promise<string[]>; invalidate(name?: string): void; has(name: string): boolean; }
interface PromptSection { name: string; compute: () => string | Promise<string>; cacheBreak?: boolean; }

// section-loader.ts
function loadSection(name: string): string;                    // throws on unknown name
function loadSections(names: readonly string[]): string;       // joined with "\n\n"
function availableSections(): string[];
function registerSection(name: string, content: string): void;

// instruction-scanner.ts
function scanInstructions(cwd: string, options?: ScanOptions): InstructionEntry[];
function combineInstructions(entries: InstructionEntry[]): string;
interface InstructionEntry { path: string; content: string; source: "managed" | "user" | "project" | "local"; depth: number; }
interface ScanOptions { fileName?: string; scanDirs?: string[]; compatFileNames?: string[]; ignoreGitBoundary?: boolean; }
```

## 怎么用 / How to use

**1. Per-turn assembly (the real engine call site, `engine/engine.ts`).** A fresh `PromptComposer` is built each turn so config/preset changes take effect on the next message, then the three builders run (two in parallel):

```ts
import { PromptComposer } from "@codeshell/core"; // export { PromptComposer } from "./prompt/composer.js"

const composer = new PromptComposer({
  cwd,
  model: this.config.llm.model,
  preset: this.preset,
  customSystemPrompt: this.config.customSystemPrompt,
  appendSystemPrompt: this.config.appendSystemPrompt,
  responseLanguage: this.config.responseLanguage,
  userProfile: this.config.userProfile,
  instructionOptions: { compatFileNames: compatFileNamesFrom(this.config.instructions) },
  disabledSkills,
  disabledPlugins,
  skillAllowlist: this.config.skillAllowlist,
  memoriesMaxAgeDays: this.readMemoriesConfig()?.maxAge,
});

const [systemPrompt, systemContext] = await Promise.all([
  composer.buildSystemPrompt(toolDefs),   // toolDefs = the filtered tool list the model sees this turn
  composer.buildSystemContext(),          // "" unless preset.injectGitStatus
]);
const fullSystemPrompt = [systemPrompt, systemContext].filter(Boolean).join("\n\n");

// Prepend CLAUDE.md + memory as the first message
const userContextMsg = composer.buildUserContextMessage();
if (userContextMsg) messages.unshift(userContextMsg);
```

**2. Building a preset's behavior prompt from sections (`preset/index.ts`).** Sections are pure markdown joined by name — a preset just lists which it wants:

```ts
import { loadSections } from "@codeshell/core"; // from "../prompt/section-loader.js"

export function buildPresetSystemPrompt(preset: AgentPreset): string {
  return loadSections(preset.promptSections); // e.g. ["base", "coding", "orchestration", "tone"]
}
```

## 注意 / Gotchas

- **Sections are read from disk via `readFileSync(new URL("./sections/<name>.md", import.meta.url))`, not bundled as JS imports.** The package build must copy `sections/*.md` into `dist/prompt/sections` or `loadSection` throws at runtime. The `md.d.ts` `*.md` declaration is only for typecheck — don't rely on `import x from "./foo.md"`.
- **`loadSection` throws on an unknown name** (with the available list in the message). Register runtime sections with `registerSection(name, content)` *before* a preset references them; built-ins win over custom on name collision.
- **The composer is rebuilt every turn on purpose** — it caches sections only within its own lifetime, so config/preset hot-reload is achieved by constructing a new instance. `invalidateCache()` exists for in-place reuse but the engine doesn't lean on it.
- **`SectionCache.resolve` filters out falsy (empty) results** and skips recompute only when `cacheBreak` is not set and the name is already cached — so an empty section silently disappears from the prompt.
- **Tool listing intentionally emits only `name + one-line description`, not JSON schema.** Provider clients send the full schema in the native `tools`/`functions` field; dumping schema here would double every tool's tokens per request. Keep it name+description.
- **Skill/plugin/allowlist filtering in `ComposerOptions` must mirror the Skill tool's dispatch gate** (`scanSkills` with the same flags). If the prompt's skills listing and the executor's allowlist drift, the model sees skills it can't actually invoke.
- **`buildUserContextMessage` uses local date, not `toISOString()` UTC** — deliberate, so "today" is right for users past midnight in their tz. Memory injection is best-effort: a `MemoryManager` failure is swallowed and yields `""`.
- **`scanInstructions` shells out to `git rev-parse --show-toplevel`** to find the scan ceiling (3s timeout); outside a repo it scans only cwd unless `ignoreGitBoundary` is set. It reads files synchronously while walking the tree — fine per-turn but not for hot loops. Compat file names default to `CLAUDE.md`, `AGENTS.md`.
