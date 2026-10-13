# Panel Video Studio correctness review

Workspace: `/Users/admin/.codex/worktrees/panel-remaining-review-20261012/codeshell-panel-apps`

HEAD: `aabba34ca94f7081fd7de4e20c52443f08f36d5e`

Branch: `codex/panel-shared/review-remaining-20261012`

Scope: `apps/video-studio/src` and `apps/video-studio/native`, read-only review. Repository AGENTS.md / CODESHELL.md / CONTRIBUTING.md read first. No product or generated package files changed; no publishing.

## Confirmed finding

### V1 / [P2] A full-source reversed video loses its first picture frame

V1 is the consolidation index label; the archived author report did not number this single finding.

Primary location: `apps/video-studio/src/editor/clip-edits.ts:1079-1082`.

Reachable ordinary workflow: import a video, add it to the timeline using the material `+`, select the clip, use the timing inspector's reverse button, and seek to the clip start or export starting there.

The default added media clip spans source `[0, asset.duration]`: `workspace-ui.ts:1001` and `1043-1046`. The timing inspector button at `timing-ui.ts:406` dispatches the reverse edit; `timing-edits.ts:324` calls `reverseClip`. Reversing the control points makes local time zero map to `asset.duration`, which is an exclusive source boundary. `evaluate.ts:369` therefore removes the video layer at the first output frame. This is accepted by validation, which explicitly permits source endpoints at duration (`time.ts:119` onwards).

At the shared evaluator level, the first frame has no video picture layer, so it exposes the sequence background or tracks underneath. The single-frame model has no video picture layer in its only frame; the longer model loses its first layer. Encoded MP4 pixels were not verified. Preview uses this evaluator (`preview.ts:143`); native export starts at frame zero (`native/media/editor-export.ts:195-197`) and the render entry uses the same evaluator (`render-entry.ts:77-80`).

Evidence: `reverse-boundary.mjs` calls the real validated model, `reverseClip`, `applyEditorOperations`, and `prepareEvaluator`, without stubs in that path. The generated one-frame video *model* has duration 8000 ticks at 30 fps. No external or user media is loaded.

| Case | First-frame picture layers |
| --- | ---: |
| Original forward clip | 1 |
| Same clip reversed | 0 |
| Reverse reversed again | 1 |
| Reversed clip trimmed so its source endpoint is inside a longer asset | 1 |
| Three-frame full-source reverse, frames at 0 / 8000 / 16000 | 0 / 1 / 1 |

The reversed one-frame map is `{0→8000, 8000→0}`; at local tick 1, the picture layer returns. This isolates the exclusive upper-boundary mismatch. The evaluator also reports no audio contribution at exact local tick zero, but no exported-audio defect is asserted: the native PCM renderer has a separate sampling path and its reverse-PCM tests passed.

Evidence limit: actual encoded reversed MP4 pixels were not verified. The native browser-rendering tests below timed out in this environment. The confirmed failure is the real shared evaluator's missing picture layer, with the export call chain established by source. Fix should reconcile reversed endpoint sampling with the evaluator's half-open source interval; this review does not prescribe a specific correction.

## Tests executed

All suites launched with the Core helper `scripts/run-isolated-node-smoke.mjs`. It creates a temporary HOME/XDG/runtime environment and removes inherited Host/account settings before starting the review fixture. Real model, provider, account and browser-profile integrations were not enabled.

1. `run-suite.mjs`: default `scripts/check.mjs --tests-only --suite video-studio`, with network-denial preload before product imports.
   - TypeScript catalog: 1139 tests, 1136 passed, 3 skipped, 0 failed.
   - Native voice-runtime catalog: 6 tests, 5 passed, 1 skipped, 0 failed.
   - Workspace-storage catalog: 5 tests, 5 passed, 0 failed.
   - Total: **1150 tests; 1146 passed, 4 skipped, 0 failed**.
   - `offline-suite.log` records the full test names and results. No `REVIEW NETWORK DENIED` request occurred.
2. `run-native.mjs`: five additional native suites, generated media and exact test-created HTTP origins only.
   - `video-studio-editor-audio-pcm.test.mjs`
   - `video-studio-portable-bundle.test.mjs`
   - `video-studio-editor-sync-runtime.test.mjs`
   - `video-studio-editor-task-runtime.test.mjs`
   - `video-studio-editor-multicam-native.test.mjs`
   - **73 tests; 67 passed, 6 failed, 0 skipped**, 230369 ms.
   - Passing cases include actual 48k PCM, stereo, gain/pan/fades, speed/pitch/reverse/freeze, ducking, nested mappings, original-audio detachment, stage/commit checks, proxy/inspect/waveform jobs, multicam correlation and cancellation/cache behavior, concurrent sync siblings and recovery, ZIP round trips/ZIP64/decompression limits/CRC/path confinement, and cancellation cleanup without partial imported documents.
   - Six browser-picture cases reached native render and failed after the renderer's 30-second timeout. This is recorded as an environment/test limitation, **not a confirmed product finding**. No `REVIEW NETWORK DENIED` request occurred. The renderer was configured with newly created test-local browser profiles, not operator browser profiles.
3. `reverse-boundary.mjs`: confirmed finding, original/reversed/restored/trimmed/three-frame controls. All assertions passed, with the expected recorded failure state for reversed upper-boundary pictures. `reverse-boundary.log` records exact output.
4. `mix-concurrency.mjs`: twelve controlled pairs of actual concurrent `prepare-audio` requests on the same source/document plus a third cache-reuse request. Own lavfi-generated 440Hz PCM WAV and own temporary runtime. No corruption reproduced; every third request returned `reused: true`. This is a negative result for the investigated cache-publication hypothesis, not proof of all possible schedules.

### Native picture-rendering limits

The following six cases failed with `画面渲染超时`, so their end-to-end picture/export assertions remain unverified:

| Test file | Test start line | Case |
| --- | ---: | --- |
| `tests/video-studio-editor-multicam-native.test.mjs` | 418 | recorded angle cuts export actual red-blue-red picture while preserving master PCM |
| `tests/video-studio-editor-task-runtime.test.mjs` | 266 | installed CLI stages, mixes, renders verified video and reuses exact mix |
| same | 339 | native export two-track overload progress/bound result |
| same | 379 | range export preserves settled ducking and binds range receipts |
| same | 418 | range overload warnings measure selected PCM |
| same | 462 | fast SDR preview NTSC timestamps / shared Chromium frame seek |

Do not report these as successful native video exports, or turn the timeout into a product regression without an environment control.

## Coverage ledger

`module-inventory.csv` and `module-inventory.json` enumerate **every one of the 204 in-scope files, 87370 lines**, including native test files and one CSS file. Per-file fields specify full manual read, focused manual read (with sections), or not manually read; default/native test dependency-graph membership; and whether an in-scope test file was executed.

- Manual: 45 full files, 14 focused files, 145 not manually read.
- Default-suite dependency graph: 133 files.
- Additional native-suite dependency graph: 53 files.
- Union: 152 files; 52 outside either executed graph.
- Dependency inclusion is **not** line or branch coverage and does not prove that each function executed. `default-suite-dependency-graph.json` and `native-suite-dependency-graph.json` include the exact graph input set and entry points. The native graph includes equivalent source entry points used by the dynamically bundled native suites; its browser renderer virtual import is represented by the separate render-entry input.

Manual work concentrated on durable session/write ordering, workspace and Host storage, portable manifests, import/publication identity, edit history and retiming, shared frame evaluation, audio planning/PCM, export staging/cache/progress, cancellation and resource lifetime. UI-heavy modules and several provider implementations were not manually reviewed end to end. Full local-model/provider execution, online cloud sync, live Host recovery/restart, and all user-facing browser interactions remain untested in this subreview.

## Fixture and artifact index

Archived review-owned files are under `validation/video-studio/`; original execution paths and byte hashes are recorded in `validation/evidence-index.json`:

| Artifact | Purpose |
| --- | --- |
| `REPORT.md` | This report |
| `module-inventory.csv`, `module-inventory.json`, `inventory-summary.json` | Complete per-file ledger and totals |
| `inventory.mjs`, `*-dependency-graph.json` | Reproducible offline graph derivation, no product outputs |
| `deny-network.mjs` | Deny HTTP/HTTPS/fetch/TCP/TLS/UDP before product import |
| `exact-local-network.mjs`, `owned-origins.txt` | Allow only exact own 127.0.0.1 origins registered when test servers listen; deny other network |
| `run-suite.mjs`, `offline-suite.log` | Default offline regression catalog |
| `run-native.mjs`, `native-suite.log` | Additional native media/bundle/sync/runtime tests and timeout evidence |
| `reverse-boundary.mjs`, `reverse-boundary.log` | Confirmed reverse-boundary failure and controls; fixture regenerates its API bundle |
| `mix-concurrency.mjs`, `mix-concurrency.log` | Own audio/cache schedule fixture; generated `concurrency/` media/runtime removed after verification |

Example reproduction, from the Panel worktree:

```sh
node /Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/scripts/run-isolated-node-smoke.mjs /Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/docs/review-remaining-2026-10-12/validation/video-studio/reverse-boundary.mjs
```

Git status was clean after the review. No candidate cache bug is promoted: concurrent same-app work is possible in Host (parent reviewer verified `maxConcurrent=2`), but this review's twelve controlled native schedules passed.

Cleanup: all review exec sessions completed. The generated `api.mjs` bundle and 82 MB `concurrency/` media/runtime directory were removed; source fixtures and logs remain. Running the documented fixture rebuilds its bundle, and the concurrency fixture regenerates its own WAV and runtime. No media binaries need archival.
