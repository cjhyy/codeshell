# Initial static locator response (transcription)

The initial combined source-read / consumer-locator tool response ended with `exit_code: 2` after successful reads of the two existing tests. The `rg` arguments included the real `packages/core/src/engine` directory and an erroneous extra `packages/core/src/engine.ts` path. Relevant original diagnostic:

```text
rg: packages/core/src/engine.ts: No such file or directory (os error 2)
```

That nonexistent path is SKIP and is not a source-manifest entry. The useful directory results are partial locator evidence only. No product code or test was executed by that command. No fixture was repaired or rerun. Subsequent explicit inventory identified the existing `packages/core/src/engine/engine.ts` for static consumer inspection only; no Engine is constructed or run.
