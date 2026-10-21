# Cost-history keyboard selection synchronization

The Session click in `ModelTracesView` queues heading focus with
`requestAnimationFrame`. The cost-history E2E previously focused a request and
then sent global Enter. The delayed heading focus could occur between those
steps, leaving the requested detail unopened. The test now waits for that queued
frame and activates the request through its locator's `press("Enter")`. This
keeps real keyboard coverage and changes no production renderer behavior.

This is separate from Host lifecycle PR #193. Its original
[Electron failure](https://github.com/cjhyy/codeshell/actions/runs/39541355612/job/119029592302)
remains unchanged. That run timed out waiting for `cost-trace-missing`, but did
not upload the cost fixture's screenshot or active-element evidence. The race
below produces the same symptom; it does not prove that run's exact cause. The
same baseline had previously
[passed the cost E2E](https://github.com/cjhyy/codeshell/actions/runs/39465032286/job/118794066729).

## Deterministic regression evidence

A headless browser loaded the existing real production view and its owned
bridge fixture with an isolated HOME and intercepted in-memory origin. No
Electron Host, model, or provider was started for this check. A controlled rAF
queue forced the Session heading-focus callback between request `.focus()` and
global Enter: focus moved to the H2, and the target detail/read was absent.
The negative assertion was immediate; it did not rely on a 30-second timeout.

In the second sequence, the callback queue contained the production focus and
then the test's frame barrier. Flushing in registration order, awaiting the
barrier, and calling the request locator's `press("Enter")` selected the target
and displayed its detail. The recorded result was:

```json
{"reproduced":true,"productionView":true,"forcedSchedulingOnly":true,"stolenFocus":{"tag":"H2","text":"Executions and calls"},"firstEnterDidNotSelect":true,"frameBarrierThenLocatorPressSucceeds":true,"originalCiCauseProven":false,"hostRuntimeStarted":false}
```

The task worktree retains the bounded reproduction and JSON result under
`artifacts/cost-trace-focus-regression.{mjs,json}`. These investigation artifacts
are ignored, rather than adding another fixture-source extraction mechanism to
the maintained test suite. The actual changed `selectTrace` helper is validated
by the complete cost-history E2E below. Independent diff review passed.

## Validation

On baseline `eaa5e2d6fc904ade914043b3c2820604a87a7ee2` plus this test patch:

- `bun run build`: passed.
- `bun run --cwd packages/desktop build`: passed.
- `bunx eslint packages/desktop/scripts/e2e-runtime-cost-history.mjs`: passed.
- `node packages/desktop/scripts/e2e-runtime-cost-history.mjs`: exit 0 with both
  final PASS markers. Its deny-all guards, synthetic HOME/userData, production
  IPC, trace detail selection, known/unknown/partial costs, renderer reload, and
  fresh temporary Electron cold restart all completed. Evidence includes
  `acceptance.json`, `cold-restart.json`, and screenshots of all three calls.
- `git diff --check`: passed.

Task evidence is retained in `artifacts/cost-history-e2e.log` and
`artifacts/cost-history-acceptance.json`. The browser mechanism check used the
already installed Chromium headless shell 1223; the actual cost E2E used the
locked Electron 33.4.11. These are synthetic receipts, not provider billing or
paid-model evaluations. The user's running App and data were not restarted or
modified. No retry of PR #193, merge, or release was performed.
