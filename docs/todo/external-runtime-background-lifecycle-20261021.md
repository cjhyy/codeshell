# External Runtime background custody — 2026-10-21

## Scope and evidence

External Runtime replacement previously followed the same teardown path as a
business Session close: `startExclusive` called `stopExclusive`, whose
`releaseHostSession` called `backgroundWork.dropSession`. Desktop wires that to
`backgroundJobRegistry.dropForSession`, which deletes the job and invokes its
abort handle. A delegated CLI could therefore disappear when the parent runtime
was recreated, even though the business Session and its task still existed.

This change separates physical-runtime replacement from business-session close.
It contains no Panel-specific behavior, does not change any live user Goal, and
does not expose new tools or change CLI permissions.

## Resulting behavior

- Replacing a runtime releases its browser/tool registrations and pending
  approvals, while retaining its business Session's delegated jobs and results.
- A completion arriving between physical runtimes stays queued and wakes the
  replacement through the existing notification path.
- If replacement close/start fails, the original window retains custody of the
  surviving work. Another renderer cannot claim or cancel it.
- Explicit Session stop, owner-window close, and application shutdown still
  cancel retained jobs, including those left without a provider after failure.
- An already-paused Goal is not resumed by replacement or background completion.

## Validation

At the task commit's baseline `origin/main` (`eaa5e2d6f`):

- `bun run build` passed.
- Guarded shard for `external-runtime-service.test.ts`,
  `external-runtime-goals.test.ts`, and `external-runtime-state.test.ts` passed:
  **124 tests, 0 failures**. Six new lifecycle regressions include the actual
  background registry abort handle, completion during replacement, replacement
  close/start failures, owner isolation, and paused Goal behavior.
- `bunx tsc -p packages/desktop/tsconfig.json --noEmit` passed.
- Targeted ESLint passed with 0 errors and one pre-existing `prefer-const`
  warning in `external-runtime-service.test.ts`.
- `git diff --check` passed.

The running Desktop application was not rebuilt in place or restarted. These
source changes are not loaded into that running process.

## Separate work and limitations

An existing independent, unmerged commit `44ddd1210a144e82bd64a6690c98b9c6d41fe540`
implements external Goal background waiting. Its worktree was inspected read-only
and was not edited or integrated here. This lifecycle patch does not replace that
waiting implementation.

Existing gaps remain separate: external Goal budget resets between automated
submissions; a queued wakeup can outlive a later pause; notification consumption
precedes durable acceptance; and foreground MCP calls can hit a client timeout.
Background registry/notification ownership is still process-local, so this is
not application-restart recovery or a complete 24-hour scheduling guarantee.

The safe current execution fallback is a separately supervised, bounded CLI
workflow with checkpoint artifacts and an absolute deadline. Persistent scheduling
and reviewed external-runtime scheduling tools require their own authority and
recovery work; directly editing the shared cron store is not part of this fix.
