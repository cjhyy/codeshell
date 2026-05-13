Create CODESHELL.md at ${targetPath} by drawing on this repo's existing AI configs.

Existing configs to investigate (read them first):
${existingConfigs}

## Survey the codebase first

Read whichever of these exist and are relevant: package.json, Cargo.toml, pyproject.toml, go.mod, pom.xml, README.md, Makefile, tsconfig.json, vite.config.*, webpack.config.*, .github/workflows/, .gitlab-ci.yml. Identify build/test/lint commands, languages, frameworks, package manager, and any non-obvious workflow quirks.

## How to treat existing AI configs

Treat them as **investigation sources, not text to copy**. Only carry forward statements you can verify against the codebase:

- Commands (build/test/lint): run them with Bash to confirm they work.
- File paths and directories: verify they exist with Read or ls.
- Conventions and constraints: find a concrete example in the code before keeping the rule.

Statements you cannot verify, that look stale, or that are too generic ("write clean code") — leave behind. When prose conflicts with config, trust config.

## What to do

1. Read every config listed above.
2. Survey the codebase to fill in any commands or conventions missing from those files.
3. Write a single CODESHELL.md at ${targetPath} that synthesizes only verified rules. Do not concatenate.

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
