# fix(core): serialize remaining user settings writers

Draft PR: T3; base `main` at `fcd8406d5`; head `codex/core/t3-settings-locks`.
Implementation checkout: `/private/tmp/codeshell-architecture-t3`.

Model switching and plugin uninstall previously performed independent read/modify/write cycles on user settings, allowing them to overwrite another writer's update. Model persistence now uses the Engine's existing `SettingsManager.saveUserSetting("defaults.text", entry.key)`, retaining the best-effort warning boundary. Plugin cleanup now reads and mutates through `mutateJsonFile`, sharing the directory lock, preserving 0600 writes and skipping absent, malformed, non-object or unchanged settings.

Evidence confirmed both writers were unlocked. The existing plugin uninstall integration tests already covered 0600 permissions, so they were retained and included in validation. The new Engine path inherits the manager's existing JSON/YAML layer selection, validation and cache invalidation: YAML data is preserved when a JSON write-back is created, and an invalid settings layer is retained instead of overwritten. Saving failures do not fail an otherwise valid model switch.

Regression coverage was added to the two existing test files: unrelated and unknown keys survive, permissive existing file modes tighten to 0600, malformed files remain byte-for-byte unchanged, YAML data survives model selection, cached settings reflect the selection, and a separate process performing plugin cleanup waits for a competing lock holder and preserves its newly committed data. No new test files or `mock.module` calls were introduced.

Validation:

- `bun run build`: passed.
- `bun run typecheck:workspaces` after the build: passed for all workspaces, including Desktop and the Web SPA. The first attempt found stale materialized Desktop dependencies in the copied local dependency tree; those local copies were replaced with workspace links, then the entire command passed. No tracked dependency files changed.
- `bun run lint`: passed, 0 errors / 98 warnings (baseline 98).
- `bun run lint:test-shards`, `bun run lint:engine-bypass`, `git diff --check`: passed.
- Guarded targeted run of `persist-active-model.test.ts`, `pruneDisabled.test.ts`, `pruneDisabledIntegration.test.ts`, `manager.single-setting.test.ts`: 37 passed, 0 failed. After improving child cleanup, `pruneDisabled.test.ts` was rerun: 12 passed, 0 failed.
- Guarded three-contract run (`architecture-budgets`, `package-boundaries`, preload `ipc-contract`): 27 passed, 0 failed.
- CI unit shard 31 (core plugins): 360 passed, 2 failed. Both failures are `loadPluginHooks` SessionStart cases and independently reproduce with the original `fcd8406d5` production files: macOS `/usr/sbin/diskutil info -plist /dev/disk3s5` fails because the DiskManagement / DiskArbitration framework is unavailable in this environment. Both emitted the same complete error. This is a local execution limitation, not a passing shard.
- CI unit shard 1 (core engine): interrupted (exit 130) after repeated fixture-provider `model_error` failures and waits. A targeted control run using original `fcd8406d5` production files reproduced both `engine.primary-cache-accounting.test.ts` failures and captured the same diskutil framework failure before provider invocation. The temporary instrumentation and baseline source substitution were restored exactly; neither is in the commit.

Not validated: all CI unit shards as a complete successful run; required GitHub CI checks; CC independent review. No PR was pushed, merged or claimed complete by this implementation agent. The coordinator owns final combined verification and draft PR creation.

Local evidence logs:

- `/private/tmp/codeshell-t3-build.log`
- `/private/tmp/codeshell-t3-typecheck.log`
- `/private/tmp/codeshell-t3-lint.log`
- `/private/tmp/codeshell-t3-tests.log`
- `/private/tmp/codeshell-t3-prune-recheck.log`
- `/private/tmp/codeshell-t3-contracts.log`
- `/private/tmp/codeshell-t3-shards.log`
- `/private/tmp/codeshell-t3-engine-bypass.log`
- `/private/tmp/codeshell-t3-core-plugins.log`
- `/private/tmp/codeshell-t3-core-engine.log`
- `/private/tmp/codeshell-t3-baseline-model-error.log`
- `/private/tmp/codeshell-t3-baseline-plugin-errors.log`
