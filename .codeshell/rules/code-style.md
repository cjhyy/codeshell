---
description: TypeScript code style rules for Code Shell
globs: "**/*.{ts,tsx}"
---

# Code Style

- Use double quotes for strings
- Always use semicolons
- 2-space indentation
- Max line width: 100 characters
- Trailing commas everywhere (`all`)
- Use `type` imports when importing only types: `import type { Foo } from "./bar"`
- Prefer `const` over `let`; avoid `var`
- Use `.tsx` extension only for files containing JSX (Ink components)
- Run `npx prettier --write <file>` to format before committing
