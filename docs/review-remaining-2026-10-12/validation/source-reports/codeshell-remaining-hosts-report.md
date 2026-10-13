# Remaining Host review — 2026-10-12

Source: `/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell`, frozen `62a58ac8702835f848108e152234a6bdd6c3eb3f`. Review-only. Read `CODESHELL.md`, old review `docs/review-2026-10-12/README.md` and `priority-and-coverage.md` from the previous server-desktop-review tree before triage. Product source, generated output, primary checkout and the root review documents were not changed by this agent. All fixture/report writes use `/tmp/codeshell-remaining-hosts-*`.

## Confirmed candidate: N01 / P2 — idle unauthenticated Chrome native TCP peer prevents Desktop quit

- Primary defect: `packages/desktop/src/main/browser-runtime/chrome-native-server.ts:88-103`. `stop()` destroys only `this.client` and then awaits `server.close` without a deadline. `accept()` at 131-176 does not track incoming unauthenticated sockets and has no authentication timeout; the socket becomes `this.client` only at 154-156 after a complete valid auth line.
- Reachability: Desktop boot starts this loopback bridge at `main/index.ts:3367`. A local process connects to its listening `127.0.0.1` port but sends no complete auth line (or pauses during the handshake), and the user quits Desktop. No token or authenticated request is needed to hold the accepted TCP connection open. This is local-only; no remote reachability or authentication bypass is claimed.
- Real lifecycle chain: `main/index.ts:7197` includes `chromeExtensionRuntimeService.stop()` in awaited `Promise.allSettled`; `chrome-extension-runtime.ts:115-126` awaits the native server stop; `desktop-shutdown.ts:25-31` awaits cleanup before invoking `quit()`. The quit event is prevented while the promise is pending.
- Impact: graceful quit remains pending indefinitely while that peer stays connected; bridge state remains on disk, while `status()` already says `listening:false` because the field was cleared before the awaited close completed.
- Reproducer: `/tmp/codeshell-remaining-hosts-native-stop.mjs`.
- Final raw log: `/tmp/codeshell-remaining-hosts-native-stop.log`.
- Exact invocation: `node scripts/run-isolated-node-smoke.mjs /tmp/codeshell-remaining-hosts-native-stop.mjs > /tmp/codeshell-remaining-hosts-native-stop.log 2>&1` (source tree cwd).
- Isolation/evidence level: maintained Node smoke isolator, Node v25.8.1; private HOME verified; source `chrome-native-server.ts`, `chrome-native-protocol.ts` and `desktop-shutdown.ts` imported directly via Node type stripping plus one exact `.js`→`.ts` resolver mapping. No dist or Core imports. Before source import, net listeners restricted to ephemeral `127.0.0.1` and connections to the exact fixture-owned port; HTTP/HTTPS/fetch and native subprocess methods denied. No real Chrome/profile/account/browser launched. This exercises the real native server and shutdown handler, with unrelated renderer flush/operation resolution steps replaced by resolved callbacks; full Electron app was not launched.
- Failure/control receipts: authenticated peer stop settled in 1ms and removed state; an accepted unauthenticated idle peer still had `stopSettled:false`, `cleanupSettled:false`, `quitCount:0`, state present after 1252ms; explicitly destroying that owned peer immediately allowed stop/cleanup/quit to settle and removed state; an invalid complete auth line was rejected and stop settled normally. Final wrapper exit 0.
- Fixture correction retained: first attempt waited for the client's `connect` event but not the server-side `connection` event. That raced `stop()` before `accept()`, so stop settled normally and the assertion failed (exit 1). The final fixture waits for actual server accept before quitting. The first output was overwritten during rerun; its tool-return excerpt was: `{"case":"unauthenticated-idle-before-peer-close","waitedMs":1252,"stopSettled":true,"cleanupSettled":true,"quitCount":1,"preventCount":1,"stateStillPresent":false,...}` followed by `AssertionError true !== false`. It is a harness readiness correction, not product counterevidence to the accepted-socket case.
- Cleanup: all owned client sockets destroyed, real source listeners stopped, temporary native state directory removed, maintained isolator removed private HOME. Source fixture and result log intentionally retained as evidence.
- Old-86 dedup: distinct from R80 (Chrome idle disconnect still shown active) and R31 (server close ordering before native job shutdown); this is an unauthenticated raw TCP socket omitted from native bridge shutdown.

## Static candidates deliberately not reported as confirmed findings

1. IM pending startup cancellation: `im-gateway-service.ts:417-425,430-561,623-650,1226-1230`. `stop`/`dispose` can finish while `startTask` is suspended before `active` publication; late startup may then run. No dynamic execution performed (root dependency gate pending, then scope explicitly moved to Panel). Same-window Link UI disables Stop during its own pending start, reducing the straightforward UI trigger; application startup/quit and another window need careful reachable lifecycle confirmation. Do not publish this as confirmed yet.
2. TunnelManager shared `child` identity looked race-prone under direct concurrent class calls; actual Desktop MobileRemoteController uses a serial queue and generation guards, so the observed production call chain counters the alleged race. No finding.
3. `runs-service.ts` applies a 10000-entry scan cap before sorting timestamps; very large legacy archives might hide newer runs. No fixture, threshold/actual usability not confirmed. No finding.
4. Web `useRemoteSocket` reconnect cleanup leaves some old socket handlers assigned; a plausible late-open race was not proved because closing a CONNECTING socket ordinarily prevents `open`. No finding. Stale OPEN mobile connection without pong also remained speculative, with no blackhole network simulation.
5. Static filesystem TOCTOU limitations explicitly documented in routing code, unavailable legacy media business operations, and already published TODO/unreleased capability boundaries excluded.

## Actual coverage and counterevidence

“Full” below means the implementation file was read through in this review; “selected” distinguishes relevant ranges/diff/rg inspection from exhaustive file review. Static inspection is not execution. Some long command outputs were truncated, and those files are labeled selected rather than asserting complete line coverage.

### Desktop account/sidebar/cloud availability (a66f..62a)

- Read diff names and changed hunks for all 13 Desktop paths: main `cloud-account-ipc.ts`, `cloud-account-manager.ts`, their tests, `desktop-remote-services.test.ts`; preload `cloud-account-api.ts`; renderer `Sidebar.tsx`, `account/AccountSidebarEntry.tsx`, fixture/test, `i18n/ns/settings.ts`, `settings/CloudAccountSettings.tsx`; shared `cloud-account.ts`. Read `docs/desktop-cloud-account.md`.
- Full implementation reads additionally: `main/cloud-account-http.ts`, `main/cloud-account-ipc.ts`, `main/cloud-account-manager.ts`, renderer account/settings components.
- Checked top-frame/main-window IPC authorization, canonical relay origin, bounded HTTPS body/deadline/no redirects, capability booleans, login/logout/refresh generations, reply origin fences, event-over-initial-status ordering. These provide positive counterevidence; no new defect established. Tests were inspected selectively, not run.

### Desktop task inbox / logs / runs / subagents

- Full inbox implementations: `main/task-inbox/{task-inbox-actions,task-inbox-service,task-inbox-ipc,task-inbox-background-host,task-inbox-projector,task-inbox-store,task-inbox-mappers}.ts`. Selected extensive source adapter read: `task-inbox-sources.ts` (session/subagent/background/automation/Mimi action ownership); `main/index.ts:6870-6995` glue. Pure types/Pet view were not independently exhaustively audited.
- Full renderer reads: `task-inbox/{useTaskInboxFeature,taskInboxViewModel,taskInboxNavigation}.ts`; `TaskInboxPage.tsx:1-320` selected (fetch/pagination, version queues, cancel/retry/open actions and navigation). `OperationResolutionReview.tsx` not re-reviewed here.
- Full `main/{logs-service,runs-service,run-history-service}.ts`; renderer `logs/LogsView.tsx`, `runs/RunsView.tsx`, `subagents/{SubagentSessionDetail.tsx,SubagentNavigation.ts}`. Existing tests selectively read, not executed.
- Positive checks: immutable paginated snapshots and sender-bound cursor grants; authoritative source/revision reread before side effects; per-task queues and completed destructive-action dedupe; failed projection writes do not re-run controls; vanished records become stale/open-only; async UI generations; bounded log/run metadata reads; read-only subagent navigation. No new confirmed defect.

### Desktop IM gateway

- `main/im-gateway-service.ts` extensive selected read: status/setup/config storage, serialized notification/start handoff, start/stop/dispose, owner-target resolution and send, DingTalk discovery, WeChat login cancellation, activity and IPC registration. `main/im-gateway-chat-requests.ts` full. `main/control-server.ts` selected request entry and test references; not a fresh exhaustive control-server audit.
- Renderer `credentials/LinkTab.tsx` selected gateway buttons and pending guards; `DingTalkSetupDialog.tsx:80-295` lifecycle/close read. Existing gateway tests selected lazy factory, owner-send authorization and startup sections.
- Positive checks: opaque owner destinations re-resolved under current config, channel allowlists/rate limiting, longpoll cancellation, single-instance lease held until adapters settle, discovery generation ownership, config no-follow and atomic update. Pending startup candidate remains unverified as recorded above. No actual platform adapter, real account, webhook or notification delivery was run.

### Desktop media custody and generic server resources

- Full Desktop `main/media/{media-documents,media-recording-ingest,panel-media-service}.ts`, alias `media-library.ts` and `media-storage.ts`; extensive selected `media-jobs.ts` read (long output truncation). Recipe/type helpers not exhaustively audited.
- Full generic server `panels/resources/{storage,library,service,clone}.ts`. `directories/references/uploads/http.ts` not independently exhaustively read here (resource service invokes them); do not infer full Host-resource security clearance.
- Checked app+project scope hashing/authorization, bounded chunks and persisted ingest lifecycle, grant/source/staging identity verification per copy chunk, content hashes, no-follow regular file reads, optimistic document base revision and atomic version/index rollback, immutable resource publication and rollback, output destination hash and grant verification, shutdown/cancel lifecycle. Legacy media processor unavailability is an intentional migration boundary, excluded. No real processor/native media subprocess executed here.

### Independent Playwright / actual Chrome extension

- Full `main/browser-runtime/{backend,profile,playwright-backend,chrome-native-server,chrome-native-protocol,chrome-extension-runtime,chrome-extension-singleton}.ts`; extensive selected `playwright-driver.ts` (long output), `runtime.ts:1-260` and relevant close/progress methods. In-app BrowserPanel/handoff paths were prior-review scope and not freshly exhaustive here.
- Full actual extension `chrome-extension/{browser-sessions,service-worker,puppeteer-connection}.ts` (under Desktop source extension directory); full native-server tests; other browser tests selected/search only.
- Checked isolated profiles, owner/profile bindings, explicit source selection, concrete backend cleanup, page/document reference ownership, policy gates, timeout handling, extension/tab/session/grant identities, pairing expiry, takeover epoch interruption and cleanup before resumption. Old R80 deduped. N01 is the one dynamically confirmed new candidate.
- No browser process, real Chrome profile, extension installation, external navigation or real browser account was used. Chromium native teardown, OS process boundaries and renderer interactions remain unexecuted.

### Server project runtime / Docker / backup / relay / tunnel / static deployment

- Full `project-runtime/{manager,registry,lock,control-server,managed-entry,backup,proxy}.ts`; extensive selected/full-in-chunks `docker-provider.ts` (large output). Read Dockerfile and compose.yaml. `seccomp.ts` and pure type modules only referenced, not exhaustive fresh audit. Test files selectively searched/read, not run.
- Full `remote-relay/{connector,local-stream,byte-stream}.ts`, selected `protocol.ts`; full `mobile-remote/tunnel-manager.ts`, `main/mobile-remote-controller.ts`; selected large `mobile-remote/remote-host-manager.ts` launch/public-base/relay target/stop sections; full `static-files.ts` and `mobile-remote/mobile-static.ts`.
- Positive checks: owner-qualified registry and targets, generation-scoped runtime stop/reconcile, deployment labels and exact-generation cleanup, private mount credentials and loopback ports, registry lock integrity and atomic persistence, incomplete-restore marker/verification before restore, fresh installation/auth namespace, offline helper/no pull, destination and owned-volume cleanup, relay exact-origin/loopback targets/rotating credentials, bounded transport frames/backpressure, public mobile route separation and static realpath containment. No new confirmed defect.
- No Docker daemon/image/container, real tunnel process, public relay/deployment or backup/restore operation executed. These are static boundary/lifecycle reads only.

### Web Environment / PWA / video / mobile lifecycle

- Full `src/lib/environment.ts`; app `environments.ts`, `EnvironmentMenu.tsx`, `register-service-worker.ts`, `public/sw.js`, `panel-video-capture.ts`; `PanelVideoDialog.tsx` relevant initial/lifecycle/save ranges; `DesktopApp.tsx`, `PanelHost.tsx:750-865`, `AuthGate.tsx:1-145`, `ProjectsGate.tsx:160-205` selected synchronization/cleanup; full `src/hooks/useRemoteSocket.ts`.
- Positive checks: navigation addresses restricted to HTTP(S) root or /mobile; credentials not transferred across environments; bounded public-only offline SW cache, scoped cache cleanup; capture stream/track ownership, late acquisition cancellation, bytes/duration caps, pagehide abort and upload retry/objectURL cleanup; focus/online/visibility re-sync with stale reply fences. No new confirmed defect.
- No actual browser/mobile suspension, physical camera/mic, service-worker install/upgrade, captured media or public environment was exercised.

### Assistance to Core retry audit

- Read Desktop `renderer/types.ts:910-1136,1245-1303`, Web `src/lib/streamReducer.ts:180-325,430-535`, TUI `ui/App.tsx:690-910` and event switch searches.
- Web `assistant_message` only seals streamed text; TUI has no corresponding canonical-text replacement branch. Desktop main assistant canonical final text does replace its matching message. Separately started tool cards are not removed merely by `assistant_message`. Communicated to Core agent to constrain its provider retry finding; not counted again in Host findings.

## Execution scope

Only N01’s guarded pure-Node source fixture ran. No product build/install/full test suite was performed by this agent; root managed workspace dependencies. No real paid model, account, message recipient, Chrome profile or public endpoint touched. Report does not equate static coverage with live platform validation. Before scope transfer, source `git status --short` showed only root-owned untracked `docs/review-remaining-2026-10-12/`, which this agent did not create or modify.
