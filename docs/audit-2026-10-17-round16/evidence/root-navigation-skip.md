# Root static locator skip

The first combined static read successfully printed tabstops.ts, then used a guessed hyphenated file name instead of the import spelling. The first tool response ended with exit 1:

```text
cat: packages/tui/src/render/string-width.ts: No such file or directory
```

This is an explicitly labeled transcription of the first metadata tool response. The guessed path is skipped and is not source coverage, a product failure or a Bun attempt. No fixture/import/test was run. The subsequent command segment for task-sanitizer.ts was not reached. Tabstops' actual import is stringWidth.js and its lane independently uses real inventory; root does not recover this guessed locator or expand the skipped sliceAnsi direction.
