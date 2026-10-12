# Docker candidate smoke: pre-Core isolation and custody

This is test infrastructure for `scripts/smoke-project-sandboxes.mjs`. It changes
no DockerProvider, production image, Main switch, package version or deployment
configuration. Parent checkpoints include `13f31cca` (RPC/Run diagnostics),
`39afd676` (Cloud integration), browser guard `537c2a95`, model fixture
`9af62497`, and Video argv `e133a0bb`, all incorporated by normal merges.

## Connected boundaries

The driver uses a fresh private HOME and a canonical local Unix Docker socket;
it does not read operator Docker contexts, registry credentials, provider keys
or model settings. It freezes the native CLI bytes and only the reviewed helper
build context. The helper image uses Services' immutable Node base
`sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9`,
Debian's signed `20250301T000000Z` snapshot and `iptables=1.8.9-2`.
Its resulting image ID, package list, tool/source hashes and random build label
are recorded. APT signature verification remains enabled. Availability of that
historical snapshot and the resulting image/kernel behavior require Linux
verification; they have not been exercised locally.

Controller, container entry, installer, worker and approved Node descendants
install the same digest-pinned preload before their product entry can import
Core. HTTP/fetch, raw socket/TLS, UDP, HTTP2 and the complete callback/promise DNS
resolver surface are restricted. Numeric loopback lookup is allowed for Node's
literal-address listeners. Each actual preload records six transport/process
and four DNS negative probes, PID, parent PID, role, argv and policy hashes.
An allowed child must preserve or receive the exact private HOME/preload/policy
environment. Sync process APIs, shells and unreviewed executable/entry bytes
remain refused. Unreviewed `worker_threads.Worker` constructors are refused
through CommonJS and both ESM exports: isolates can otherwise discard preload
options and receive fresh, unguarded builtins. Reviewed Core workers remain
digest-pinned Node child processes, rather than Worker isolates.

The unmodified production provider's Docker verbs/argv are intercepted by a
test-only controller adapter. Fresh registry installation/project/owner,
generation, configuration digest, immutable image/container ID and the exact
loopback published port are checked before minting an origin. The seccomp path
matches the production materialized `project-runtime-security/<SHA>.json`.
Each start has independent original-executor and AbortSignal custody. Every
await before ACK publication checks cancellation; cancellation during helper
cleanup cannot return a successful adapter callback.

ACK authority is linearized when the still-authorized controller dispatches
the fixed writer. Abort of a Docker CLI process cannot atomically revoke a
writer already executing inside the container or undo its fsync. Cancellation
after dispatch remains a failed start, and the existing provider stops the
owned runtime. This fixture does not claim a cross-process atomic cancellation
protocol.

The container preload publishes a fresh boot nonce and pauses before its static
Core closure. A separate NET_ADMIN-only helper joins only that captured
container's network namespace. IPv4 and IPv6 OUTPUT default to DROP, allowing
established replies and exact loopback TCP ports 8790, 18791, 18792, 18793 and 18794. Exact permits and chain shape are checked in both families. Fixed TCP
negative probes use documentation addresses `192.0.2.1` and `2001:db8::1` after
the rules are verified; a connection refuses ACK publication. Deadline and
route-unreachable outcomes are recorded separately. No host firewall, host/PID/
mount/user namespace or production runtime image is changed.

The helper emits its receipt to the captured controller. It has no runtime data
mount and needs neither CHOWN nor FOWNER. The controller verifies image/source
inventory, actual container ID, namespace, nonce, policy digest and both rule
hashes, then invokes a fixed, digest-pinned UID1000 writer. That writer alone may
bypass the waiting barrier to publish the private fsynced ACK. Stale ACKs cannot
release a new boot. Missing, corrupt or mismatched ACKs stop before Core import.

Native Panel tools use frozen executable bytes, owned cwd and reviewed argv.
The supported business slice includes Download's fixture FFmpeg/yt-dlp,
whisper-server, Job PDF Chromium, and Video's actual WAV inspection, PCM mixing,
default 320x180 MP4 render, final probes and frame Chromium. It does not admit
arbitrary FFmpeg filters, postprocessors, protocols or export presets. Native
programs' own grandchildren are covered by the container netns firewall, not
JavaScript spawn wrappers. Video's exact frozen editor entry alone maps its
requested `127.0.0.1:0` frame listener to 18794; other entry bytes cannot use that
alias. Its actual bound origin and entry digest are part of the receipt.

Host Playwright contexts use the separately reviewed browser request guard:
service workers blocked, exact owned HTTP/WS destinations before any page,
redirects refused without following, and scoped cookies/close custody. This is
a browser request guard, not OS confinement. Driver process custody separately
pins Playwright 1.60 Chromium bytes/default argv, sandbox=true, private profile,
fixed media-capture options and captured child PID. Arbitrary native spawn is
not enabled by a browser origin receipt.

The stopped project-volume recovery retains `--network none` and adds the same
preload to its entry and three actual recovery CLI children. It uses a private
temporary HOME and permits no network/listeners/native children. This inner
recovery contract remains separate from the outer recovery fixture owned by the
integration task.

## Cleanup and evidence

Actual captured children, sockets and owned resources close independently;
primary failures and cleanup failures remain visible together. Helper cleanup
accepts only the exact daemon "No such container/object: <captured random name>"
response. Unknown custody is a failure and retains private HOME/logs. Lost helper
responses can be recovered only through the recorded random name, immutable
image/ID and both custody labels. Cleanup never issues a global kill.

PASS and HOME deletion occur only after Control shutdown, resource removal,
captured-child close and receipt validation. The sanitized
`docker-candidate-guard-receipt.json` contains image/policy hashes, PID/preload
proofs, per-boot network ACKs and native child close outcomes; it contains no
session cookies, credentials or model request bodies. Private logs are retained
on failure rather than uploaded wholesale.

## Validation and remaining acceptance

Local validation uses the guarded Bun shard. Actual native Node fixtures verify
preload-before-entry, descendant PID proofs, DNS/process refusal, tamper refusal,
the exact frozen-entry listener alias and captured live-child shutdown. A fake
native CLI validates setup/build-failure/cleanup custody. Controlled command and
browser adapters inject cancellation, namespace, IPv6, ACK, redirect, socket and
cleanup faults. These tests do not prove actual Docker, kernel, Chromium,
provider, speech, FFmpeg or Panel business behavior. No local Docker, Core, Main,
Electron, Keychain, production account or paid model was launched.

Final local combination on 2026-10-13: 102 tests, 387 assertions, zero failures
or skips across the nine Docker/browser/model fixture suites; ESLint and
Prettier pass; native Node syntax checks pass for all 15 fixture modules. The
last setup-only close refinement also receives its affected controlled Node
shard before commit. These are local fixture results, not kernel acceptance.

A follow-up builtin-only actual Node regression first failed on the original
guard: an eval Worker with empty `execArgv` and `NODE_OPTIONS` executed and
reported no installed pre-Core guard. The captured Worker was terminated before
reporting that failure. The minimal constructor refusal keeps the existing six
transport/process and four DNS receipt counts; it does not claim that the six
recorded probes include an additional Worker probe. No Core, network or native
program is used by this regression. The affected guard, setup and browser
authority shards pass 51 tests with 185 assertions and no failures or skips;
ESLint, Prettier, native Node syntax and diff checks pass.

The final fixed-source Linux gate must still build/inspect the helper image,
execute both-family rules/probes, and run the original complete business suite
with freshly frozen Host/Panel bytes. The current official Panel batch is being
refrozen after Job Hunt 4.2.1; old 3f80/Job 4.2.0 and earlier .35 receipts cannot
stand in for that new candidate. Video subtree bytes were unchanged between
3f80 and 75431542. Services wrapper network fixtures are separate unfinished
work owned by the integration task; this checkpoint does not claim the entire
outer candidate wrapper is guarded or accepted.
