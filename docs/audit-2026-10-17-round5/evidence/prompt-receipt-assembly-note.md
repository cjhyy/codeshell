# Non-test metadata assembly note

The first Python receipt-assembly command failed with `AssertionError` while parsing Bun summary lines, after the source manifest had been written. Its terminal response was:

```text
Traceback (most recent call last):
  File "<stdin>", line 15, in <module>
AssertionError
```

This is a transcription of the tool response, not a captured subprocess raw log. The count parser was corrected for documentation assembly using the unchanged first-run test logs. No test or fixture was changed or rerun; both guarded shards remain their original single successful executions.
