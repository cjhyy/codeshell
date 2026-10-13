# Final durability: existing build / validation log byte countercheck

Date: 2026-10-12. This is a read-only comparison of six existing task-owned log pairs. No tests, fixtures, product imports, builds, installation, Git, model/provider CLI, or network operations were run. Only Python standard-library file reads, SHA-256, byte lengths, line inspection, and byte-diff calculation were used. No repository files were changed. This does not add a test run or a product finding.

Raw directory: `/tmp/codeshell-review-20261012`.

Archived directory: `/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell/docs/review-2026-10-12/validation`.

## Exact byte results

Each hash is SHA-256 of `Path(path).read_bytes()` before decoding or normalization. All twelve files end in LF. Byte offsets below are zero-based and half-open; line numbers are one-based.

| File | Raw bytes | Archived bytes | Raw SHA-256 | Archived SHA-256 | Result |
| --- | ---: | ---: | --- | --- | --- |
| build.log | 3779 | 3778 | b99ec2ec00c233ab6e663631f174dbd701cd162f5d56e3f687d46f52f6da064d | f00dc4f6c8bff9ff804afb284971419359430f3171809037fbb59e7dbe5b8441 | One ASCII space deleted; all remaining bytes equal |
| typecheck.log | 725 | 725 | abf93f71c1ba4fde9f2d1ce704524a7a855c9e6bea5309317640f31453f964ba | abf93f71c1ba4fde9f2d1ce704524a7a855c9e6bea5309317640f31453f964ba | Identical |
| desktop-build.log | 6339 | 6339 | ad65d6af5256319099d7bbd2352c8a2496c57950c28a92f6fd631a144e899cc6 | ad65d6af5256319099d7bbd2352c8a2496c57950c28a92f6fd631a144e899cc6 | Identical |
| navigation.log | 139 | 139 | dea950ea1099fe16e646d076ad9eef4248d57802e707af91b2fcae471ab0082d | dea950ea1099fe16e646d076ad9eef4248d57802e707af91b2fcae471ab0082d | Identical |
| settings-e2e.log | 123 | 123 | d5f772d2a4c86c5584e8ca4ece741cd68edeaae78d864cb29abfcddafb16d142 | d5f772d2a4c86c5584e8ca4ece741cd68edeaae78d864cb29abfcddafb16d142 | Identical |
| workspace-pages-e2e.log | 484 | 484 | 0abe0870b511afd1d0fd98db40442ce1e6f711a2531444c6fdcf8d26b9b0dfa9 | 0abe0870b511afd1d0fd98db40442ce1e6f711a2531444c6fdcf8d26b9b0dfa9 | Identical |

`build.log` has 37 LF bytes in both copies. Its sole byte difference is raw span `[2773, 2774)` containing `b' '` against archived empty span `[2773, 2773)`, on line 25 in both files. The complete differing line is:

```text
raw:      b'@cjhyy/code-shell-web build: \n'
archived: b'@cjhyy/code-shell-web build:\n'
```

Thus `raw[:2773] + raw[2774:]` equals the entire archived byte string. The remaining pairs have no changed byte spans. LF counts for typecheck, desktop-build, navigation, settings-e2e, and workspace-pages-e2e are respectively 13, 103, 1, 2, and 6 in both copies.

## What the log contents establish

These statements apply equally to the raw and archived copies because the only difference is the trailing space above.

- `build.log:1` records a chained build command for link, core, pet, capability-optimization-lab, capability-coding, cdp, web, server, tui, chat, followed by `bun run scripts/build-meta.ts`. Lines 3, 6, 8, 10, 13, 15, 31, 33, 35, and 37 explicitly report `Exited with code 0` for those ten package jobs. Line 30 records the web bundle completion. The file ends at the chat package's code-0 line. It contains no explicit exit receipt for the enclosing command or final build-meta command; their numeric exit status cannot be established from this log alone.
- `typecheck.log:1` records `bun run --filter '@cjhyy/code-shell-*' typecheck`. Lines 2–13 report code 0 for twelve filtered jobs: cdp, link, chat, core, pet, capability-coding, capability-optimization-lab, arena, tui, web, server, and desktop. No enclosing process exit receipt is present.
- `desktop-build.log:1` records `bun run scripts/build.ts`. Lines 91 and 102 record Vite build completions. Line 103 explicitly records `[build] main, preload, renderer, mobile, and Chrome extension OK`. The custom aggregate success marker and named components are preserved. Chunk-size warning text is also preserved. The log contains no numeric enclosing-process exit receipt.
- `navigation.log:1` explicitly records `CodeShell navigation Electron e2e: passed`, with scope named as responsive preference, drawer focus, dismissal, page/search handoff, resize, reload, and shortcuts. It contains no process exit receipt, assertion count, timing, or exact source revision.
- `settings-e2e.log:1–2` explicitly records shortcut checks for platform keys, grouped rows, three widths, and two languages/themes, followed by `CodeShell Electron settings E2E: passed`. It contains no process exit receipt, assertion count, timing, or exact source revision.
- `workspace-pages-e2e.log:1–6` preserves six `PASS:` statements covering extensions/credentials/automation headings and light/dark layouts at 1280/820/390px; credential keyboard activation, responsive focus, filtering and clear-search focus; automation keyboard selection, one-time labels and cancel-only instruction editing; and workspace page layouts, native dark controls and keyboard interactions. These are six log statements, not independent proof of a runner test count. No process exit receipt, aggregate runner count, timing, or exact source revision is present.

The comparison establishes byte preservation of five logs and a precisely bounded one-byte presentation change in build.log. Existing logged success markers and named coverage survive archival. This read-only comparison cannot independently establish when the original commands ran, their exact source revision/environment, or an outer exit code absent from the logs; those require separate preserved command receipts or provenance. No original log or archived copy was repaired or rewritten.
