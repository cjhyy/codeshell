# C2 — Lower mechanical Core dependencies while preserving compatibility exports

Base: `codex/core/c1-path-helpers` (`7982e876726a7a5c63fa7e14e0f9c6d607206657`). Stacked draft; no merge before independent CC review.
Branch: `codex/core/c2-lower-mechanical-dependencies`. Worktree: `/private/tmp/codeshell-architecture-g1`.

Moves the remaining 10 mechanical upward dependencies to their owning or lower layers: session display projection/base64 sizing, automation source marker, disposal wrapper, credential result marker, MCP connection policy, source/profile binding schemas, Panel App pin schemas, and builtin behavior-profile values. Old module paths continue to re-export their existing symbols; all three public entries are unchanged. The moved values/functions/schemas were checked as 35 unchanged declarations using the TypeScript AST printer (log `/private/tmp/codeshell-c2-declaration-check-20261110.log`). No protocol, serialized schema or default behavior changed.

G2 upward allowlist shrinks 28 -> 18 (29 -> 18 including C1). These are exactly the 18 original design-required entries; none were modified. Same-layer allowances shrink 5 -> 2 by extracting the Panel App manifest filename constant, shared frontmatter parser, and profile/source schema fragment. No new allowance or file-size budget.

Reviewed but intentionally deferred under C2's pure-function restriction:
- `hooks <-> plugins`: `writeHookStdin` and `closeHookStdin` register/remove stream listeners, write/end streams and manage drain/error ordering. Moving the byte constant alone would leave the edge. Their real I/O lifecycle belongs in a separate design, so the existing allowance remains.
- `preset <-> prompt`: `prompt/section-loader.ts` reads built-in markdown from disk at module initialization and resolves paths relative to `import.meta.url`; moving this changes resource/lifecycle ownership. Existing allowance remains.

Validation (all tests use the guarded HOME runner):
- Full `bun run build`: PASS (`/private/tmp/codeshell-c2-build-20261110.log`).
- Full `bun run typecheck:workspaces` after build: PASS (`/private/tmp/codeshell-c2-typecheck-20261110.log`).
- Full `bun run lint`: PASS, 0 errors / 98 warnings, equal to `scripts/lint-baseline.json` maximum. Changed Core files also lint clean (0 warnings).
- Targeted existing 16-file suite (public entry exports, image policy, lifetime/registry, behavior profiles, automation prompt, settings/panel/source/profile schemas, sensitive results, plugin loaders, frontmatter scanning, unchanged composition golden): 158 pass / 0 fail (`/private/tmp/codeshell-c2-targeted-20261110.log`).
- Existing native history projection plus automation suites: 188 pass / 0 fail across 31 files (`/private/tmp/codeshell-c2-projection-automation-20261110.log`).
- Three whole-repo contracts separately: 29 pass / 0 fail (`/private/tmp/codeshell-c2-contracts-20261110.log`).
- `lint:test-shards`: PASS (2675 existing test files). `lint:engine-bypass`: PASS. `git diff --check`: PASS.

Not claimed: all Core/CI unit shards and platform E2E. The C1 run already demonstrated sandbox `diskutil`/filesystem-identity and local port-bind failures, with coordinator baseline controls; those large failing shards were not repeated at this C2 commit. Final candidate CI and independent CC review remain required. No paid eval, credentials, mock.module or new test file; no golden-fixture changes. No PR created by this delegated worker.
