# Read-only cross-review: root CLI scope

Reviewer: `document_inputs_round15`. Frozen baseline: `ae777b3fce6fc9986e69ceb62802f3bb3f6aa478`. Outcome: **no blocking reporting issue found; no new bug proposed**. No tests or product/other-report/Git writes were performed during review. This file is the only review output.

The first raw combined log names exactly the two reported existing files and contains 9 pass, 0 fail, 12 expect calls, with `Completed Bun shard: 9 tests, 0 skipped; 0 failures.` The first exit receipt records the same guarded command and exit 0. I did not rerun either file. Reading the tests confirms five parsePositiveInt tests and three actual context-resolver tests; the ninth test reads repl.ts and asserts source strings. cli.md accurately labels this as a source-wiring assertion and does not claim a REPL/Commander program.parse/model session ran. The 12 expectation count also reconciles with six helper assertions in the integer tests plus three helper and three source-string assertions in the context file.

The integer function validates decimal syntax/positive integers and throws the imported InvalidArgumentError. Root report correctly restricts execution to helpers and distinguishes the Commander class from actual CLI argument/error/exit validation. Search references confirm the stated main/run/repl/runs consumer lines. The current source pins and all 13 SHA-256 hashes were independently compared to frozen `git show` blob bytes with zero mismatches; partial-consumer coverage remains labeled partial in the manifest.

Both stdio modules were read as source only during this review. Nullish precedence and missing-cwd fallback match cli.md. Their settings/host classification dependencies were not imported or exercised; neither report nor review asserts settings persistence, permission, Host state, worker startup or no-project behavior has run.

The root dedup script recursively scans all prior docs/bugs Markdown and JSON string leaves, excludes round15, retains bounded nearest-match contexts and reports 1,102 MD + 723 JSON = 1,825 files, 200,618 JSON **string** leaves, zero parse errors. This differs legitimately from the Documents worker's count of all scalar JSON leaves. Its matches explicitly preserve the old May 30 unvalidated parseInt/NaN finding and July REPL duplicated context resolver finding. Root correctly excludes them from new findings and does not turn old plan “Expected: FAIL” into a current failed run. The beyond-safe-integer/direct invalid config examples have no demonstrated ordinary accepted producer here and are not promoted.

Reviewed artifact hashes (metadata only):

- `cli.md`: `8cf1b6e7397b6b2d7ad8ddbd4ff9a1fb827676bf2a401fdff8126a99498f67ea`
- `evidence/root-cli-existing.first.log`: `bfdbf1af3b42937bc8e4f6c6945710360d01cb5a65394e1dda3a7a490c4ed159`
- `evidence/root-cli-existing.first.exit.json`: `80a0b0d04183bf082e50c5c84b8aae62590b3a0be6ea41517c4659ffb59d7a7f`
- `evidence/root-source-manifest.json`: `93b6fdb0002b9872ba925b9f4f40eff056e0a7714ca38ef8bdd4d5fb809702dc`
- `evidence/root-dedup.json`: `46e8652375da805039f83686cb94439fc4b06a682d659734a68cdbe70d91c6f1`
- `evidence/root-dedup.py`: `8e5d960d2507a730eb345c7d66d41fb97cf153e8fa4d8873a2057134ea3db781`
