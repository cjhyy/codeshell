# Mobile remote acceptance — 2026-10-29

User objective: 把手机遥控全部过一遍，然后全部能 work，找出问题都修复了。

This is an in-progress acceptance ledger, not a completion claim. The current
turn made progress: real bugs were reproduced and fixed, and acceptance was
extended through actual Desktop/WS/CLI, browser and file-transfer boundaries.

## Delivery state

- Runtime/session fixes: PR #232, `codex/desktop/mobile-runtime-sessions`, separate
  worktree `mobile-runtime-sessions/codeshell`. Head `f63506c7a` includes the fixed
  client-authentication smoke race and all 29 real WS/canonical/legacy CLI
  lifecycle scenarios. Latest-head CI is running.
- Panel/workspace/file/access fixes: PR #233, this worktree. Follow-up `e4b8310e9` added
  shared binding invalidation, authoritative session-root migration, 2 GiB
  workspace file transfers, post-I/O revocation checks, public socket passcode
  rotation and explicit revalidation UI. Latest-head CI is running. Earlier
  `24d558f40` passed all 14 CI checks; that does not certify later commits.
- Combined merge `9df242ff5` incorporates both PRs, runtime `f63506c7a`,
  Web/download/access changes, and integration test contract fixes. Both navigation
  and test insertion conflicts preserve the two implementations.
- Actual Video Download consumer acceptance passed in Node with natural exit 0.
  Fragmented Cloudflare URL and stale-start-result fixes are in `4c6f0d700`.
  Final combined acceptance and latest-head CI remain in progress.
- Neither PR is merged or released. `/Applications/code-shell.app` is still
  version **0.9.47**. The installed client has not been replaced.

## Acceptance scope

| Flow                                                                  | Current evidence                                                                                                                                                                                                                                                                                                               | Remaining                                                                                           |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| Pairing, access passcode, LAN/tunnel/relay, logout, revoke, reconnect | 112 connection/device tests; 151 access-revalidation/socket/hook/UI tests; 48 public-start tests; real local TLS relay covers rotation and preserved pairing. Counts overlap.                                                                                                                                                  | Combined final source acceptance; Cloudflare runtime issue below                                    |
| Native sessions and project selection                                 | Real socket + controller/hook regressions cover rapid selection, stale replies, reconnect, catalog gaps and root migration; explicit Link/pending/CLI scopes remain fixed                                                                                                                                                      | Re-run relevant acceptance after combining both PRs                                                 |
| Claude Code and Codex                                                 | Default isolated Node smoke passes 29 scenarios: original 12, canonical 8 and legacy rooms 9. Real production dispatchers/services and physical synthetic child processes; 103 cold records paginate 100+3; selected models, resume, >1 MiB histories, approval ACK/replay, observing, stop/close and process cleanup verified | Latest-head CI; final combined-code smoke                                                           |
| Chat and approvals                                                    | Browser mobile/chat-operations/latest-message suites; 138 reconnect/approval boundary tests; actual native output journal and external CLI smoke. Tests include uncertain sends, background/liveness, stale callbacks, scope, free text and pending replay.                                                                    | Final combined-code run; do not substitute legacy room success for canonical runtime success        |
| Models/permission/goal controls                                       | Production model-actions browser (50 observations), native/CLI handlers, synthetic provider/worker service tests                                                                                                                                                                                                               | Verify combined code and retain explicit unsupported-method behavior                                |
| Panel open/load/bind/install/update/remove                            | Real opaque iframe+tunnel capability smoke; shared native/primary/secondary/worktree bindings; native disable/uninstall notifications; actual Video Download reviewed install, native task, mobile history capture and exact 151552-byte save passed with natural Node exit 0                                                  | Final combined-code acceptance and CI                                                               |
| Files and attachments                                                 | Production file browser at 320/390/760/1280px; 28 transfer tests; real paired Desktop HTTP >100 MiB preview/HEAD/range/revoke; 30 final file/auth/native-revocation tests                                                                                                                                                      | Final combined-code checks                                                                          |
| Panel resources/media                                                 | 390px real MediaRecorder audio/camera/isolated-tab video tests pass, including lost upload acknowledgements, exact output and device cleanup. Inline image canvas/WAV seek/scoped fetch/revocation passes.                                                                                                                     | Final CI includes isolated browser stages                                                           |
| Settings/MCP/Skills/Links/activity/history/devices                    | 11 production browser suites pass; real Desktop/HTTP/management service 6-file suite passes 70 tests. Additional devices browser has 30 observations.                                                                                                                                                                          | Final combined-code acceptance                                                                      |
| Automation                                                            | Current phone UI has no standalone automation management route. Panel automation bridge is covered by real Desktop Web/automation fixture and shared task acceptance.                                                                                                                                                          | Do not claim the desktop automation page was tested on mobile                                       |
| Layout/offline/long output                                            | Mobile 320px light/dark and short viewports; sidebar 14 layouts; service worker 11 cases; latest-message 8 layouts; real output journal and CLI multi-page histories                                                                                                                                                           | Final combined-code acceptance; physical phones have not been tested                                |
| Integration/delivery                                                  | Workspace typecheck, full Desktop build plus final main build, lint baseline (0 errors/98 existing warnings), architecture/test-shard guards pass. Actual Electron main/preload/guest+paired HTTP executes an owned background task with exact output and primary-project bookmark/worktree execution scope preserved.         | Refresh main, integrate eligible green PRs, run final combined acceptance and record delivery state |

## Real installed tunnel observation

Read-only inspection found the user's existing cloudflared process (PID 50991)
exposes metrics on `127.0.0.1:20741`. At inspection, `/ready` returned **503** and
`cloudflared_tunnel_ha_connections` was **0**. Its recorded quick-tunnel hostname
also failed DNS lookup (`ENOTFOUND`). No user process was restarted, no passcode
was read or changed, and no public pairing identity was used.

This is evidence of a current real transport failure, separate from the code bugs.
Local TLS/browser/synthetic-cloudflared tests must not be reported as actual
Cloudflare public connectivity or a physical Safari/Android acceptance. Keep
the existing installed-client recovery pending. A separate private quick tunnel
subsequently established a real edge connection, passed system DNS and two public
DoH lookups, and served the exact owned HTTPS health marker in about seven seconds.
Its child and temporary HOME were removed; original PID 50991 was not modified.
This proves current network/public transport can work for a fresh tunnel; it does
not prove the existing installed-client tunnel has recovered.

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
