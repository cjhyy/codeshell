# Final D1 / Desktop / Host targeted verification

Candidate: `d65afec5b2af55ee3ed4f9de657005edd90fb0ea`.
Repository: `/private/tmp/codeshell-architecture-review-20261110`.
Completed: 2026-11-10 07:48:11 UTC.

All three groups passed using `node scripts/run-bun-test-shard.mjs --timeout 30000` with task-specific `TMPDIR=/private/tmp/codeshell-architecture-tmp` and the runner's isolated HOME. Dependency builds had finished before these invocations; no source, HEAD or dist was modified by this verifier. HEAD matched the candidate before launch and after every group.

| Group | Files | Passed | Failed | Exit | Log |
|---|---:|---:|---:|---:|---|
| D1 | 9 | 113 | 0 | 0 | `/private/tmp/codeshell-final-followup-d1.log` |
| Desktop acceptance-gap group | 5 | 54 | 0 | 0 | `/private/tmp/codeshell-final-followup-desktop.log` |
| Host acceptance-gap group | 2 | 14 | 0 | 0 | `/private/tmp/codeshell-final-followup-host.log` |

Total: **181 passed, 0 failed across 16 files**. Every group has a complete Bun summary and an exit-0 guarded-runner receipt. Commands, full candidate SHA, timestamps, counts and HEAD checks are in `/private/tmp/codeshell-final-followup-results.json` and the individual `codeshell-final-followup-{d1,desktop,host}.json` files.

The D1 group includes the actual AgentBridge fixture's 22 lines / 22 parses and deep-frozen input checks through all readers, plus the frozen nested stream-event normalization/snapshot/annotation/replacement regression. It also covers no-child replies, worker Host routing, web configuration, quick-chat forks, host-action dispatch and browser interception.

The Desktop group covers `browser-driver/automation-host.test.ts`, `browser-driver/scenario-e2e.test.ts`, `desktop-shutdown.test.ts`, `third-party-notices.test.ts` and `preload/external-runtime-routing.test.ts`. The Host group covers `services/mcp-probe.http-transport.test.ts` and `services/model-connection-probe.test.ts`. These close the specifically identified changed-test gaps; they do not turn failed or incomplete full partitions or native/browser smoke into passes.

Earlier attempts on `f31986b4268231ee7ce1b9fcc5a63d2098cbd98a` also passed but overlapped a coordinator typecheck that rebuilds dist. They are preserved under `/private/tmp/codeshell-final-followup-*-scheduling-overlap.{log,json}`, with `validation_accepted:false` and explicit scheduling annotations. They are not used as clean acceptance evidence. The current results above are the clean repeat after the coordinator confirmed builds had ended and supplied the final SHA.

No CC review, agent CLI, paid evaluation, package-release, build, source change or branch mutation was performed in this verification task.
