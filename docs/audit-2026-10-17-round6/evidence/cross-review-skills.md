# Read-only cross-review — root package and Task/Todo

Reviewed the final `root-package.md`, `tasks.md`, first raw combined stdout/stderr logs, exit receipts, fixtures, metadata receipts, source/caller contracts and saved dedup corpus on frozen `cef9ff76167d33a6a6e5b4464ba5313f7fd35f79`. This review added only this Markdown record; it did not add, edit, repair or execute tests, run a build, access a provider/network, or mutate Git. **Both directions correctly retain zero new confirmed findings. No blocking evidence or scope issue remains in the reviewed final materials.**

## Root package

- The only first shard matches the command receipt: `tests/build-meta.test.ts` + `tests/package-boundaries.test.ts`. The raw log has **17 pass / 123 expect / 0 fail**, `Completed Bun shard: 17 tests, 0 skipped; 0 failures.`, and the saved exit is `0`. These are existing baseline tests, not new candidate reproductions or proof of a complete release.
- Read the actual build test and `scripts/build-meta.ts`: the test copies the production script unchanged into its own temporary root, where `import.meta.url` derives an owned `dist`. It supplies a fake TUI entry and launches only the resulting shim/fake to verify arguments and executable bits. There is no test call to build the shared checkout's `dist` or to run real product CLI behavior. The final report explicitly says that the temporary verbatim copy ran and shared checkout build did not; this resolves the earlier ambiguous “production build-meta not executed” wording.
- `tests/package-boundaries.test.ts` reads source/manifests and calls release metadata helpers. `publishCommands` is pure command construction; importing `publish-release-packages.ts` does not invoke its guarded `main`. The report's no npm query/publish/network and no full release smoke/install/typecheck claim is consistent with this fixture/source inspection.
- The watch entry remains only a static configuration candidate. `package.json:42` directly runs watch; `bun-test-completion.mjs:117–118` rejects watch; `CODESHELL.md:140–145` states the guarded unit-shard rule. Neither watch behavior nor product impact was executed, and the report assigns no severity or confirmation. The old task-branch release-tag issue is already recorded at prior audit A11 (`docs/audit-2026-10-16/root.md:91–96`) and is correctly excluded from new counts.

## Task/Todo

- All three independent first logs and exit receipts agree with the final report and machine receipt: **snapshot 7 / 161; display 4 / 91; existing TUI 2 / 28; total 13 tests / 280 expect / 0 fail / 0 skip**. Every shard has Completed and exit `0`. The two loops each enumerate 40 supported status snapshots inside one test; they are not 80 extra tests.
- The fixtures invoke real TodoWrite/readLastTodoSnapshot, TaskGuard and the stream wrapper with memory callbacks; Desktop reader/fold/reducer and Web reducer are actual source consumers. The TUI baseline uses the existing fake AgentClient with Ink mount and input fixtures. The final report correctly distinguishes that fixture rendering from real CLI/PTY/provider/user-session execution, and label components remain static inspection.
- Read current contract source: TodoWrite is a complete replacement snapshot; transcript is its store; there is no supported independent CRUD/dependency subsystem. Invalid outer arrays, tolerant item parsing, position ids and all-completed clear agree between live and replay helpers. The child stream branch forwards/returns before the parent's latestTodos update. TaskGuard resets on array replacement. The zero-findings conclusion is limited to inspected/tested conditions.
- The four exclusions are justified, kept separate from findings, and not counted as bugs: removed legacy CRUD, accepted non-emission of empty resume state, previously fixed guard age reuse, and consumer-specific todo visibility. All-completed resume is documented in the archived plan and explicit current test `engine.todo-resume.test.ts:88–112`; that Engine test was read, not run. Desktop child omission is an explicit design choice; Web source intentionally omits main todo. The final report's TaskList reference was tightened to its actual EOF (`13–60`).
- Independently matched all **41 source receipt rows** against their on-disk SHA and frozen Git bytes; all match. All three test-file, raw-log and exit SHA values match their receipt. All **15 artifact receipt rows** match bytes/SHA. Reparsed all **338 saved dedup JSON files**, checked every saved SHA, and found no parse/hash mismatch. The stated 512 Markdown corpus is consistent with all prior audit/review files/directories plus every docs archive/_archive tree; the count includes the single root-level review Markdown. The report explicitly distinguishes 2,229 classified nested objects from a finding count and limits keyword-based dedup conclusions.

## Final material hashes

The following SHA-256 values identify the reviewed final materials. No product probe was run during this review.

- `root-package.md`: `6133ea2d1da96928a496ccb96dfb115da3b9df32abf37f95b9dca2d684b7cf62`
- `tasks.md`: `2ef34a8a8b7a4a3c761f33211c74dc7279a272cc87b1662e9e4434c5c7106883`
- `evidence/root-package-baseline.first.log`: `99efe288598ad3bec7e15cc5b5b8ffceb6b0ae29bdbdc5650b644be6dc38b4a6`
- `evidence/root-package-baseline.first.exit.txt`: `9a271f2a916b0b6ee6cecb2426f0b3206ef074578be55d9bc94f6f3fe3ab86aa`
- `evidence/root-package-baseline.receipt.json`: `88014767c63ca88625e5469595735a02d170328bfeca432ce553d2bec94be5e8`
- `evidence/tasks-receipts.json`: `e059447432cd4f317e9438160a5c5814edf0d2b0053cf219a021303a92df4ac9`
- `evidence/tasks-source-manifest.json`: `cf7bc671fc3ab8501eb287a78ef6961d23b2f909217f09b75172c88be657b6d9`
- `evidence/tasks-artifact-receipt.json`: `19ca834e0f1e2289859f6da3109e52fe4ae055053a3179cbd4393919a53c8e03`
- `evidence/tasks-findings.json`: `ed4b85ea070e58ee3cf97b9b4362eada125fbacc9b1876eebd5c9b9da138232a`
- `evidence/tasks-candidates-and-dedup.json`: `1269f5bd4127c87a0f5bb5ea16f9350475d0a1f9f81b8c3c587aee8affce5ccf`
- `evidence/tasks-dedup.json`: `034f650a0dbed33521715e38e42279e616871bdbfd13a01dea1a79534e6a1057`
