# Static source-navigation errors — tool-response transcription

The first read-only export locator included unverified filenames. The relevant combined output is transcribed here; it is not a Bun/product log:

```text
rg: packages/core/src/extension.ts: No such file or directory (os error 2)
rg: packages/core/src/internal.ts: No such file or directory (os error 2)
```

The overall shell/tool response was exit 0 because the rg command was piped to `head`; that does not mean those files were read. Root skipped the guessed public entry-file direction, made no public export claim from it, and did not substitute filenames to restore it.

A separate compound static read printed the already-existing composition index, then failed on another guessed path:

```text
sed: packages/core/src/preset/types.ts: No such file or directory
exit_code: 1
```

The guessed preset type-file direction was skipped. The independently inventoried compiler/types and existing fixtures were already read and remain the basis for ordinary composition metadata controls. These diagnostics were not product test failures; no filename repair, platform experiment, fixture repair or alternate validation recovered the skipped directions.
