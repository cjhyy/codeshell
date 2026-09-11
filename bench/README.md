# bench/

Local performance benches for `packages/tui/src/render`. Not run in CI. Output is plain text
to stdout, one table row per measurement plus auxiliary counters
(`bytes_written`, `frame_count`, `write_count`).

## Run

    bun run bench:render            # all benches in sequence
    bun run bench/render-tail.bench.ts
    bun run bench/render-streaming.bench.ts
    bun run bench/render-spinner.bench.ts
    bun run bench/render-wheel.bench.ts

## Scenarios

| File                        | Scenario                                 | Measurement                                                              |
| --------------------------- | ---------------------------------------- | ------------------------------------------------------------------------ |
| `render-tail.bench.ts`      | Mount 10k transcript                     | Tree creation through first terminal frame                               |
| `render-streaming.bench.ts` | 200 streaming deltas atop 5k history     | All 200 committed prop updates through the final frame, after warm mount |
| `render-spinner.bench.ts`   | Spinner ticks 60× atop 5k history        | All 60 committed prop updates through the final frame, after warm mount  |
| `render-wheel.bench.ts`     | 100 `scrollBy` steps over 10k transcript | Each step includes a 20 ms throttle/paint settle wait                    |

Baselines are recorded in `packages/tui/src/render/README.md` under "Perf baselines".

## Interpretation guide

These benches mount React trees against a fake stdout. They measure how much
the renderer writes and how long it takes — not real terminal repaint latency.
Use them to catch regressions (relative deltas), not as absolute SLOs.

`frame_count` comes from the renderer's `onFrame` callback; `write_count` counts
stdout chunks. A terminal frame can contain multiple writes. Streaming and
spinner counters exclude the warm mount. Their updates yield to the event loop,
so fast updates may batch; the final frame is always awaited rather than assumed
to have finished after an arbitrary delay. All scenarios clean up their fake
terminal even if validation fails.
