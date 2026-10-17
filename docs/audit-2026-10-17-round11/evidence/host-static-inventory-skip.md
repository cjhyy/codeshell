# Static inventory failure (tool-response transcription)

This is a labeled transcription of the first tool result, not a raw test log.
Command: `rg --files docs bugs archive _archive -g '*audit*' -g '*review*' -g '*.json' -g '*.md'`
Tool exit: 2. Tool reported 25,873 original tokens and truncated the large path inventory.
The first diagnostic lines were:

```text
rg: archive: No such file or directory (os error 2)
rg: _archive: No such file or directory (os error 2)
```

No product/test execution occurred. The nonexistent top-level archive directions are skipped. The later dedup collector uses the observed existing `docs` and `bugs` roots and parses JSON leaves; nested archive/_archive paths are included naturally. No guessed path is retried and no product fixture is repaired.
