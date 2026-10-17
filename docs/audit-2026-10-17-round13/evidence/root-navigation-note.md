# Root raw-log pointer diagnostic — tool-response transcription

An initial metadata read assumed the groups focused log used the common `.first.log` suffix. The combined tool response reported:

```text
cat: docs/audit-2026-10-17-round13/evidence/groups-patch-summary.first.log: No such file or directory
```

The same command then successfully read the already inventoried exit receipt, so its overall exit was 0. The nonexistent guessed log filename was not read or retried. The receipt explicitly names `groups-patch-summary.first.raw.log`; root used that recorded pointer for material inspection. This is a metadata-pointer correction only, with a labeled first-response transcription. It neither fixes/reruns the failed product fixture nor recovers its skipped validation direction. The first product failure and original raw bytes remain preserved.
