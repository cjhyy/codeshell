# Metadata enumeration failure

The first historical-dedup collector used line-based `git ls-files` and read a Git-quoted non-ASCII path as a literal filename. No product test or Bun shard was started. A relevant excerpt transcribed from the actual tool response was:

```text
exit_code: 1
FileNotFoundError: [Errno 2] No such file or directory: /Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/"docs/archive/model-catalog-\\350\\256\\250\\350\\256\\272\\347\\250\\277.md"
```

This is a transcription of the tool response, not a Bun raw log. The metadata collector now reads NUL-delimited Git paths. No product fixture, dependency or platform failure was repaired or rerun.
