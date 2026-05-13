You are bootstrapping CODESHELL.md for an essentially empty git repository at ${cwd}.

There is no source code, no manifest, and no README to read — the user has just started this project. You must ask them what they want to build before you can write anything useful.

## How to ask

Use the **AskUserQuestion** tool. Prefer the multiple-choice form whenever the answer is one of a small known set — the user just arrow-keys + Enter, much faster than typing. Pass `options` (2-4 short entries with `label` + `description`), set `header` to a short chip (≤12 chars), and put the recommended choice first with a recommendation marker appended to its label (e.g. "(Recommended)" for English, "(推荐)" for Chinese — match the user's language). The UI automatically appends an "Other..." entry, so you don't need to include one.

**Language: write every `question`, `header`, option `label`, and option `description` in the SAME language the user has been writing in.** The sample option strings below are English placeholders showing *shape* — translate them. E.g. if the user is writing in Chinese, "CLI tool" becomes "命令行工具", "Web service" becomes "Web 服务", "(Recommended)" becomes "(推荐)", and so on.

Ask one question per AskUserQuestion call. **Hard limit: at most 4 AskUserQuestion calls total. After the 4th answer, write the file.** Stop earlier as soon as you have enough.

Recommended questions to draw from, with concrete `options` shapes (translate into the user's language):

1. **What are you building?** — header: "Project", options: "CLI tool" / "Web service" / "Library / SDK" / "Mobile or desktop app". Pick whatever fits best as recommended, or omit a recommendation if it's genuinely a coin flip.

2. **Primary language and framework?** — header: "Stack", options: "TypeScript + Node" / "Python" / "Go" / "Rust". Recommend the one most aligned with the previous answer (e.g. CLI tool → Go or Rust if performance matters, TypeScript otherwise).

3. **Package manager / runtime?** — header: "Runtime", options shaped by the language answer (e.g. for TS: "Bun" / "pnpm" / "npm" / "Deno").

4. **Any non-obvious constraint up front?** — header: "Constraints", options: "Performance critical" / "Licensing matters" / "Compliance / privacy" / "None — defaults are fine". Recommend "None" unless the project type strongly suggests otherwise.

If the user picks "Other..." on a question, treat the typed string as authoritative and move on.

If a one-word answer (e.g. selecting "CLI tool") plus the language pick clearly covers what you need, do not pad with the remaining questions. Move on.

## When you have enough

"Enough" means you can name:
- The project's purpose (one phrase)
- The technology stack (language + main framework/tool)
- At least one non-obvious convention or constraint the user volunteered

When you have these, **use the Write tool to create ${targetPath}**. Lead with:

```
# CODESHELL.md

This file provides guidance to Code Shell when working with code in this repository.
```

Then a short section listing what the user told you, plus `# TODO(user): …` placeholders for things the user explicitly didn't decide ("None" / "Other: not sure yet"). Do not invent build commands or test framework choices — leave them as TODOs if unstated.

## If the user cancels (AskUserQuestion returns "(user declined to answer)")

Stop asking. Write a minimal CODESHELL.md with whatever you have plus TODO placeholders for everything missing. Don't loop.

## Writing rules

CODESHELL.md is loaded into every Code Shell session, so it must be concise. For a fresh project the file will be short and full of TODOs — that's fine. Honesty beats fabrication.

Do not include:
- Standard language conventions the model already knows
- Generic advice ("write clean code")
- Guesses about how the user will deploy, test, or structure their code
