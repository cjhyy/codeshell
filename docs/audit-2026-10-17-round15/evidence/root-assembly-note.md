# Root metadata query note

The first compact schema-inspection command successfully returned the four source-manifest schemas and root-dedup schema. It then treated the Documents dedup `files` count as an array. Its first terminal response ended with exit 1:

```text
root-dedup.json ['baseline', 'scope', 'patterns', 'scanned', 'parseErrors', 'matchCounts', 'maxContextsPerPattern', 'hits', 'inventory'] firstRow {}
Traceback (most recent call last):
  File "<stdin>", line 4, in <module>
TypeError: 'int' object is not subscriptable
```

This is an explicitly labeled transcription of the first tool response, not a raw product log. The unsuccessful Documents schema shortcut is skipped. Published worker reports/receipts already supply its inventory counts; no dedup, fixture, parser, Bun, dependency lookup or product execution was retried. The subsequent aggregate assembler consumes the four successfully observed source-manifest schemas and explicit first-run receipt paths independently.
