# Round 12 — Desktop schedule and time display

Frozen baseline: `d5fae44358b3a92d4d02fd5fcc4ac21c56b2a08a`. Result: **0 new confirmed bugs, 0 formal candidates**. Source inspection and one first existing pure-data shard only; this is not a full automation or UI review.

## Scope and evidence

Read `packages/desktop/src/renderer/automation/scheduleModel.ts`, its existing test source, `timezones.ts`, `relativeTime.ts`, their existing test sources, and the corresponding frequency/timezone edit sections of `AutomationView.tsx`. The source-only translation imports in `packages/desktop/src/renderer/i18n/translate.ts` and `packages/desktop/src/renderer/uiLanguage.ts` establish that scheduleModel carries the bare Web language dependency. No localization API was invoked and the previously skipped i18n validation direction was not restored.

The first guarded invocation was:

```text
node scripts/run-bun-test-shard.mjs --timeout 30000 packages/desktop/src/renderer/automation/relativeTime.test.ts packages/desktop/src/renderer/automation/timezones.test.ts
```

[Raw combined stdout/stderr](evidence/root-time-display-existing.first.log) and [exit receipt](evidence/root-time-display-existing.first.exit.json) were saved before inspection: **12 pass, 16 expectations, 0 fail, 0 skipped**, guard completed. Relative-time cases inject `now` and a key-echo translator; timezones use the installed runtime's Intl data. This does not validate current external timezone legislation, DST transitions, real scheduler timing, persisted jobs, mounted controls, or localization.

## Observations not promoted

- `scheduleModel.ts:69–73` maps any digit-hour interval into `hourly`, and `:115–116` builds that model as a wall-clock cron expression. For example the source maps `5h` to the model that would build `0 */5 * * *`; `AutomationView.tsx:62` only offers `[1,2,3,4,6,8,12]`. There is a possible imported non-option schedule/editing boundary. Backend semantics are unvalidated in this batch and no ordinary unintended save was demonstrated, so this is a **source-only observation**, not a new bug or formal candidate. Opening the detail only parses local state (`:633–641`); saving requires a schedule edit (`:657–662`). Changing timezone saves only timezone (`:1038–1040`). Do not claim that merely opening a job or changing timezone rewrites its schedule.
- Invalid times passed directly to `buildSchedule` can reach its non-null assertion, but the inspected time-input caller requires a nonempty browser time value. No ordinary invalid-time producer was established. `0h`, non-finite timestamps, and invalid timezone names were not manufactured as product triggers.
- `relativeTime.ts:13–19` rounds approximate relative units; its own contract says “约”. Boundary rounding alone does not establish a precision defect.
- The modern timezone list delegates to `Intl.supportedValuesOf` and the fallback is deliberately small. The existing test title mentions UTC but only asserts a large list plus Shanghai. No claim about UTC option availability, an actual UI failure, or completeness beyond runtime support is made.

## Historical dedup and skips

[Structured dedup](evidence/root-dedup.json) scanned all prior `docs`/`bugs` Markdown and parsed JSON, including archives: **1,060 Markdown + 598 JSON = 1,658 files; 152,326 JSON string leaves; 0 parse errors**. Current round excluded. Hits on old Core `parseSchedule` fallback/zero-interval defects concern a different parser and are not repeated. ScheduleModel/timezone hits were chiefly inventory, old test manifests, and implementation plans; no new finding was inferred from a test filename or archived assertion alone.

[Initial navigation diagnostic](evidence/root-navigation-skip.md) preserves the failed guessed Core cron-folder inventory as a labeled tool-response transcription. That direction is skipped; no backend validation or alternative product test was used to recover it. The existing full scheduleModel test was intentionally not executed because it includes localization; this batch has no scheduleModel runtime result.

No product code changed, real automation created/edited/run, native app opened, terminal/PTY controlled, paid API called, network message sent, or shared dependency/dist rebuilt. No full build/typecheck/lint/test claim.
