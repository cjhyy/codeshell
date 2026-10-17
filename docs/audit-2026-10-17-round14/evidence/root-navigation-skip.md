# Root static inventory diagnostic — tool-response transcription

One initial inventory supplied the guessed `packages/core/src/model-trace` directory beside the valid Desktop activity directory and piped through `head`. The tool reported overall exit 0 from the pipeline, while `rg` reported:

```text
rg: packages/core/src/model-trace: No such file or directory (os error 2)
```

The guessed Core model-trace-folder direction is skipped and not read. No product test ran or was recovered through another path. Root continues only the independently inventoried Desktop activity helpers and their explicit source/type consumers; backend trace production semantics are unvalidated in this batch. A pipeline exit 0 is not evidence that the missing directory was read.
