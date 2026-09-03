# Sanitized dataset schema

## `manifest.json`

Records the schema version, selection counts, split counts, privacy guarantees,
and the source class. It never records the source's absolute filesystem path.

## `cases.jsonl`

Each line contains one case summary:

```json
{
  "schemaVersion": 1,
  "caseId": "personal-0001",
  "sourceFingerprint": "one-way truncated SHA-256",
  "split": "dev",
  "reviewStatus": "unreviewed",
  "origin": "desktop",
  "providerFamily": "openai",
  "modelFamily": "openai",
  "taskCategory": "coding",
  "outcome": { "status": "completed", "turnCount": 4 },
  "metrics": {
    "durationMs": 120000,
    "userMessages": 2,
    "assistantMessages": 5,
    "toolCalls": 3,
    "failedToolResults": 0,
    "subagents": 0,
    "compactions": 0,
    "invokedSkillCount": 0,
    "tokens": {
      "prompt": 1000,
      "completion": 200,
      "total": 1200,
      "cacheRead": 0,
      "cacheCreation": 0
    }
  },
  "distinctTools": ["Read", "Edit"],
  "traceFile": "traces/personal-0001.jsonl",
  "privacy": {
    "freeFormTextRetained": false,
    "absolutePathsRetained": false,
    "absoluteTimestampsRetained": false,
    "rawIdentifiersRetained": false,
    "toolArgumentsRetained": false,
    "toolOutputsRetained": false
  }
}
```

Token fields are `null` when an older session did not persist that value.

## `traces/*.jsonl`

Each line is one sanitized transcript event. Event order and rounded relative
time are retained. Free-form fields are represented only by size buckets and
block-type counts. Raw event IDs and correlation IDs are replaced by the local
`eventIndex`.

The exporter performs a final recursive audit of every generated JSON value and
refuses to write data containing path, email, credential, URL, or suspicious
free-form string patterns.
