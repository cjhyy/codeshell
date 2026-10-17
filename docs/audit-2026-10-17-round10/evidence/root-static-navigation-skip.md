# Root static source-navigation failure

The first attempted renderer consumer read used an unverified glob. This is a labeled transcription of the tool response, not a test/runtime log:

```text
command: rg -n '\.model|\.provider|durationMs|\.usage' packages/desktop/src/renderer/components/RunDetail* packages/desktop/src/renderer/components/Runs* --glob '*.tsx'
zsh:1: no matches found: packages/desktop/src/renderer/components/RunDetail*
exit_code: 1
```

Root skipped the guessed renderer consumer direction. No filename repair, alternative renderer fixture, native UI or runtime validation followed it. The already inventoried Core RunStore/Queue/CheckpointWriter direction remains independent. Read-only Desktop history service observations are not promoted to confirmed issues without established producer and consumer contracts.
