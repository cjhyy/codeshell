# bench/

Local performance benches for `packages/tui/src/render`. Not run in CI. Output is plain text
to stdout, one table row per measurement plus auxiliary counters
(`bytes_written`, `frame_count`).

## Run

    bun run bench:render            # all benches in sequence
    bun run bench/render-tail.bench.ts
    bun run bench/render-streaming.bench.ts
    bun run bench/render-spinner.bench.ts
    bun run bench/render-wheel.bench.ts

## Scenarios

| File                             | Scenario                                  | Key metric                                    |
| -------------------------------- | ----------------------------------------- | --------------------------------------------- |
| `render-tail.bench.ts`           | Mount 10k transcript, render tail         | `bytes_written`, `frame_count`                |
| `render-streaming.bench.ts`      | 200 streaming deltas atop 5k history      | `frame_count` (should reflect ~200, not 5000) |
| `render-spinner.bench.ts`        | Spinner ticks 60× atop 5k history         | `bytes_written` per tick                      |
| `render-wheel.bench.ts`          | 100 `scrollBy` steps over 10k transcript  | `perIterMs`                                   |

Baselines are recorded in `packages/tui/src/render/README.md` under "Perf baselines".

## Interpretation guide

These benches mount React trees against a fake stdout. They measure how much
the renderer writes and how long it takes — not real terminal repaint latency.
Use them to catch regressions (relative deltas), not as absolute SLOs.
