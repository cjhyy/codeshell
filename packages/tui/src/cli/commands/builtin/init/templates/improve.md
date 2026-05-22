Improve the existing CODESHELL.md at ${targetPath}.

## Survey the codebase first

Read whichever of these exist and are relevant: package.json, Cargo.toml, pyproject.toml, go.mod, pom.xml, README.md, Makefile, tsconfig.json, vite.config.*, webpack.config.*, .github/workflows/, .gitlab-ci.yml. Identify build/test/lint commands, languages, frameworks, package manager, and any non-obvious workflow quirks.

## What to do

1. Read the current CODESHELL.md.
2. Identify concrete, specific improvements grounded in what you found in the codebase:
   - Missing build/test/lint commands
   - Generic advice that should be cut
   - Gotchas/conventions found in code but not documented
3. Apply the improvements using the **Edit** tool, one change at a time. Each Edit call must use a minimal, unique `old_string` and the replacement `new_string`, so the user sees a focused red/green diff per change. Do not use Write — Write replaces the entire file and hides what actually changed.

## Writing rules

CODESHELL.md is loaded into every Code Shell session, so it must be concise — every line must answer "would an agent likely miss this without help?".

Include:
- Build/test/lint commands the model can't guess (non-standard scripts, flags, sequences)
- Code style that DIFFERS from language defaults
- Testing quirks (e.g., how to run a single test)
- Repo etiquette (branch naming, PR conventions, commit style)
- Required env vars or setup steps
- Non-obvious gotchas

Exclude:
- File-by-file structure (discoverable by reading code)
- Standard language conventions the model already knows
- Generic advice ("write clean code")
- Commands obvious from manifest files

Be specific. "Use 2-space indentation in TypeScript" beats "Format code properly."
