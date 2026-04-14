---
description: Testing conventions for Code Shell
globs: "tests/**/*.test.ts"
---

# Testing

- Test framework: **vitest** (not Jest)
- Test files go in `tests/` with `.test.ts` extension
- Use `describe`, `it`, `expect` from vitest
- Run all tests: `npm test`
- Run single test: `npx vitest run -t 'test name'`
- Run single file: `npx vitest run tests/filename.test.ts`
