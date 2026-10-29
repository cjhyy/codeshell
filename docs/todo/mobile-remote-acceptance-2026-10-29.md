# Mobile remote acceptance — 2026-10-29

User objective: 把手机遥控全部过一遍，然后全部能 work，找出问题都修复了。

This is an in-progress acceptance ledger, not a completion claim. The current
turn made progress: real bugs were reproduced and fixed, and acceptance was
extended through actual Desktop/WS/CLI, browser and file-transfer boundaries.

## Delivery state

- PRs #232 and #233 were integrated through normal protected fast-forward at
  `c2fb65b361018364440629220463b3f2b4577a50`. Eligible PR CI run `40755689061`
  passed all 14 required checks on that exact candidate.
- The reviewed Video Download consumer is pinned to the published Panel repository
  commit `84348855be8ae4e5a31936b3c2b0d1d21410bd64`. Its full Video Download and
  shared trees match the reviewed consumer. Actual Node acceptance passed with
  natural exit and exact downloaded bytes.
- The actual local app has been updated from 0.9.47 to a verified **0.9.48** build
  of `c2fb65b`. All old owned processes exited normally before installation.
  Binary rollback copies and delivery evidence live outside disposable worktrees.
  The user completed the macOS Keychain prompt. The original unsent draft was
  restored and verified without sending it; provider selection was preserved.
- Current actual Desktop Main owns the listening HTTP port and its Cloudflare
  child. Public HTTPS reaches the expected passcode challenge; the configured
  passcode and all 11 trusted devices remain intact. No test device was paired
  and no real provider request was submitted for acceptance.
- Installed-profile validation uncovered a separate persisted-history defect:
  a legacy unpaired-output marker blocks some old sessions. Canonical transcript
  and output journal were compared on private stable copies. The repair preserves
  raw originals and provider context, backs up projections, requires an explicit
  historical-gap acknowledgement, and retires old cursors, approvals and queued
  sends. It executes no model or tool. Unsupported or unexplained mismatches stay
  blocked. The recovery follow-up is in progress and is **not installed yet**.
- The follow-up also journals future external background/cold-Goal notifications
  and starts the worker before the fixed archive-marker migration query. The
  previous cold-start path silently dropped that query and waited 120 seconds.
- Current task branch incorporates newer main commit `e9133d461` (PR #235).
  Follow-up integration, eligible CI, packaged validation and local delivery remain
  pending. No public release or tag has been made.

The table below records the original broad mobile acceptance. Its original
integration/delivery items are satisfied by the c2fb65b delivery above; the newly
found legacy-history repair has its own outstanding delivery gate.

## Acceptance scope

| Flow                                                                  | Current evidence                                                                                                                                                                                                                                                                                                                | Remaining                                                                                          |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Pairing, access passcode, LAN/tunnel/relay, logout, revoke, reconnect | 112 connection/device tests; 151 access-revalidation/socket/hook/UI tests; 48 public-start tests; real local TLS relay covers rotation and preserved pairing. Counts overlap.                                                                                                                                                   | Actual installed-client recovery and delivery below                                                |
| Native sessions and project selection                                 | Combined real socket + controller/hook regressions cover rapid selection, stale replies, reconnect, catalog gaps and root migration; explicit Link/pending/CLI scopes remain fixed                                                                                                                                              | Final eligible CI and installed-client delivery                                                    |
| Claude Code and Codex                                                 | Combined isolated Node smoke passes 29 scenarios: original 12, canonical 8 and legacy rooms 9. Real production dispatchers/services and physical synthetic child processes; 103 cold records paginate 100+3; selected models, resume, >1 MiB histories, approval ACK/replay, observing, stop/close and process cleanup verified | Final eligible CI and installed-client delivery                                                    |
| Chat and approvals                                                    | Combined browser mobile/chat-operations/latest-message suites; 138 reconnect/approval boundary tests; actual native output journal and external CLI smoke. Tests include uncertain sends, background/liveness, stale callbacks, scope, free text and pending replay.                                                            | Final eligible CI and installed-client delivery                                                    |
| Models/permission/goal controls                                       | Combined production model-actions browser (50 observations), native/CLI handlers, synthetic provider/worker service tests                                                                                                                                                                                                       | Final eligible CI and installed-client delivery                                                    |
| Panel open/load/bind/install/update/remove                            | Combined real opaque iframe+tunnel capability smoke; shared native/primary/secondary/worktree bindings; native disable/uninstall notifications; actual Video Download reviewed install, native task, mobile history capture and exact 151552-byte save passed with natural Node exit 0                                          | Correct consumer source reference; final eligible CI and installed-client delivery                 |
| Files and attachments                                                 | Combined production file browser at 320/390/760/1280px; 28 transfer tests; real paired Desktop HTTP >100 MiB preview/HEAD/range/revoke; 30 final file/auth/native-revocation tests                                                                                                                                              | Final eligible CI and installed-client delivery                                                    |
| Panel resources/media                                                 | 390px real MediaRecorder audio/camera/isolated-tab video tests pass, including lost upload acknowledgements, exact output and device cleanup. Inline image canvas/WAV seek/scoped fetch/revocation passes.                                                                                                                      | Final CI includes isolated browser stages                                                          |
| Settings/MCP/Skills/Links/activity/history/devices                    | Combined 11 production browser suites pass; real Desktop/HTTP/management service 6-file suite passes 70 tests. Additional devices browser has 30 observations.                                                                                                                                                                  | Final eligible CI and installed-client delivery                                                    |
| Automation                                                            | Current phone UI has no standalone automation management route. Panel automation bridge is covered by real Desktop Web/automation fixture and shared task acceptance.                                                                                                                                                           | Do not claim the desktop automation page was tested on mobile                                      |
| Layout/offline/long output                                            | Combined mobile 320px light/dark and short viewports; sidebar 14 layouts; service worker 11 cases; latest-message 8 layouts; real output journal and CLI multi-page histories                                                                                                                                                   | Physical phones have not been tested                                                               |
| Integration/delivery                                                  | Combined workspace typecheck, full Desktop build plus final main build, lint baseline (0 errors/98 existing warnings), architecture/test-shard guards pass. Actual Electron main/preload/guest+paired HTTP executes an owned background task with exact output and primary-project bookmark/worktree execution scope preserved. | Refresh main, integrate eligible green PR, build and verify local package, preserve live user work |

## Real installed tunnel observation (historical and recovered)

Read-only inspection found the user's existing cloudflared process (PID 50991)
exposes metrics on `127.0.0.1:20741`. At inspection, `/ready` returned **503** and
`cloudflared_tunnel_ha_connections` was **0**. Its recorded quick-tunnel hostname
also failed DNS lookup (`ENOTFOUND`). No user process was restarted, no passcode
was read or changed, and no public pairing identity was used.

This was evidence of a real transport failure, separate from the code bugs.
Local TLS/browser/synthetic-cloudflared tests must not be reported as actual
Cloudflare public connectivity or a physical Safari/Android acceptance. Keep
the existing installed-client recovery pending. A separate private quick tunnel
subsequently established a real edge connection, passed system DNS and two public
DoH lookups, and served the exact owned HTTPS health marker in about seven seconds.
Its child and temporary HOME were removed; original PID 50991 was not modified.
This proves current network/public transport can work for a fresh tunnel; it does
not prove the existing installed-client tunnel had recovered.

The actual installed app was subsequently recovered through its normal Settings
UI: close the failed remote transport once, then enable the public Cloudflare
transport once. Original PID 50991 exited; the new child reported `/ready` 200,
one ready connection and `cloudflared_tunnel_ha_connections` 1. Its public hostname
resolved and unauthenticated HTTPS `/mobile/` reached the Host passcode challenge.
The configured passcode and all 11 trusted-device records remained intact; no
phone was online during the operation. The new address/QR is displayed in the app.
An existing Claude task was still alive after closing remote, then the app's
execution observation recorded normal completion after 817.91 seconds. No App
restart, model request, credential change or CLI stop was performed. An unsent
Desktop draft was subsequently preserved through the local update described above.

## Evidence logs

- `/tmp/codeshell-owned-cloudflare-dns-diagnostic.log`: actual private Quick
  Tunnel, live edge, matching DNS records and exact HTTPS marker; cleanup verified.
- `/tmp/codeshell-tunnel-recovery-final.log`: 41 tunnel/controller/binary tests;
  includes fragmented URL, stale readiness success/failure and actual 32 MiB pipe
  output with same-child reconnection.
- `/tmp/codeshell-mobile-video-download-node-final.log`: reviewed 0.24.1 Panel
  through actual Host native entries, mobile history/resource save, 14 guarded
  child processes, exact bytes, natural Node exit and no retained children.
- `/tmp/codeshell-mobile-all-external-lifecycles.log`: 29 real Node/WS/CLI scenarios,
  zero failures, no retained fixture child processes.
- `/tmp/codeshell-mobile-access-revalidation-tests.log`: 151 tests.
- `/tmp/codeshell-mobile-relay-access-rotation-tests.log`: actual TLS relay rotation.
- `/tmp/codeshell-mobile-public-start-gates-tests.log`: 48 tests.
- `/tmp/codeshell-mobile-connection-matrix-tests.log`: 112 tests.
- `/tmp/codeshell-mobile-reconnect-approval-tests.log`: 138 tests.
- `/tmp/codeshell-mobile-workspace-migration-tests.log`: 85 hook/controller tests.
- `/tmp/codeshell-mobile-panel-notification-after.log`: 46 hook/UI tests.
- `/tmp/codeshell-panel-native-refresh-tests.log`: 7 native notification/budget tests.
- `/tmp/codeshell-mobile-all-management-host-tests.log`: 70 actual Host/service tests.
- `/tmp/codeshell-mobile-all-*-browser.log`: mobile-workbench, sidebar/navigation,
  history, settings, MCP, skills, Links, model-actions, sidebar focus, activity,
  chat operations, file browser, devices, latest messages and service worker.
- `/tmp/codeshell-mobile-all-file-transfers.log`: 28 transfer tests.
- `/tmp/codeshell-mobile-all-large-file-paired.log`: 16 paired HTTP tests.
- `/tmp/codeshell-mobile-files-final-auth-tests.log`: 30 tests, including an actual
  paused FileHandle preview read followed by workspace revocation.
- `/tmp/codeshell-mobile-all-audio-capture-phone.log` and
  `/tmp/codeshell-mobile-all-video-capture-phone.log`: real 390px recording flows.
- `/tmp/codeshell-mobile-all-inline-media.log`: real image/WAV inline resource flow.
- `/tmp/codeshell-mobile-all-tunnel-downloads.log`: real iframe+tunnel download flow.
- `/tmp/codeshell-mobile-video-download-ui-tests.log`: actual Panel source,
  53 production-page Chromium tests with synthetic Host APIs.
- `/tmp/codeshell-mobile-video-download-flow-tests.log`: 92 download/queue/binding tests.
- `/tmp/codeshell-mobile-all-electron-paired-tasks.log`: actual Electron shared task.
- `/tmp/codeshell-mobile-all-typecheck-final.log`,
  `/tmp/codeshell-mobile-all-desktop-build.log`,
  `/tmp/codeshell-mobile-all-main-build-final.log`,
  `/tmp/codeshell-mobile-all-lint-final.log`,
  `/tmp/codeshell-mobile-all-shards-final.log`: build/static gates.

Use owned temporary HOME/workspaces, synthetic providers/CLI programs and exact
network/process confinement. Browser API fixtures prove UI behavior only; combine
them with actual Host/worker/process evidence. Do not sum overlapping suite counts
or mark the whole objective complete while integration, runtime or delivery
requirements remain unverified.
