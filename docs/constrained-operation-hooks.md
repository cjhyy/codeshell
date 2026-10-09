# Configured Hooks in independent operation review

The existing Settings activity review can execute explicitly authorized, finite
inline or declared Node/sh tool Hooks through a native Host process capability. It does not create
an Engine or replay the original write. The original uncertain receipt, Run,
owner incarnation, project trust, Profile, account grant and review CAS remain
the authority for the independent read.

The supported backend is an explicitly configured, already installed local
Docker daemon and immutable Linux image. The daemon, its local Unix endpoint,
the canonical Docker executable and immutable image are trusted Host runtime
components. CodeShell never pulls an image, installs a daemon, discovers an
operator Docker context or falls back to the existing unrestricted shell/plugin
runner. Native macOS and Windows process backends are not implemented.

## Native Host configuration

Desktop reads `CODESHELL_OPERATION_HOOK_HOST` once, before Main registers the
existing operation review IPC. The original two-field JSON shape remains valid:

```json
{
  "runtime": {
    "executable": "/canonical/path/to/docker",
    "executableSha256": "<64 lowercase hex digits>",
    "endpoint": "unix:///explicit/local/docker.sock",
    "image": "sha256:<64 lowercase hex digits>",
    "architecture": "arm64",
    "nodeExecutable": "/usr/local/bin/node",
    "nodeExecutableSha256": "<64 lowercase hex digits>"
  },
  "inlineCommandSha256": ["<sha256 of exact authorized command bytes>"]
}
```

The image must already exist locally, use Linux and the stated architecture,
and declare no automatic volume mounts. The canonical Docker executable and
Node executable inside that image must match the supplied hashes. The immutable
bootstrap checks Node identity, UID, zero capabilities, no-new-privileges and
seccomp before any configured code executes; the Host checks the separate
runtime header again after actual cleanup.

This startup configuration is native Host input. Project Settings `env`, Hook
output, renderer messages and model data cannot modify it. The allowlist is an
immutable startup snapshot: changing it requires restarting Main. Project
settings, plugin installation/approval definitions, owner and file authority
are checked during each review and while its process is suspended.

An authorized command hash alone is insufficient for arbitrary shell code.
The inline allowlist admits a complete small literal grammar: `:`, `exit N`, and
`printf` with a single-quoted literal, optionally a literal `%s` format and an
exit status of 0 or 2. It permits no variable expansion, external script or
explicit Host cwd. This makes the code/resource closure finite without guessing
shell dependencies. Existing settings and approved installed-plugin definitions
still decide which Hooks apply; the startup allowlist does not bypass disabled
Hooks, matchers or plugin approval.

The Host-only `ConstrainedProcessHost.capture` interface accepts an explicit
finite manifest of already authorized regular files and opaque resource tokens.
It snapshots their bounded bytes and pins file/ancestor identity and actual
revocable file authority. It never scans an installation directory or treats a
`hooks.json` approval as permission to read all plugin files.

### Optional finite resource plans

The startup JSON may additionally contain `resourcePlans`. Each plan specifies
one exact selected command/event/source, the original cwd/settings scope/Profile,
an explicit manifest of readable files, declared snapshot directories, and a
typed launch. It is native file-export authority, separate from plugin install
trust or Hook approval. There is no renderer, model, Panel, dotenv, or Settings
`env` route for creating plans, and no consent/grant inference from a command.

A Settings source is exactly `{kind: "settings", layer, path, rawSha256,
sourceLayerIndex, definitionSha256}`. It must match the actual bounded RAW
snapshot that produced that selected validated Hook. A plugin source is exactly
`{kind: "plugin", installKey, installPath, installEntrySha256, hooksDigest,
approval, approvedHookDigest, rawEvent, key}` and must match the actual installed
registry and existing approval. Missing, ambiguous, higher-precedence unresolved,
or unproven source selection cannot fall back to another resource plan. Ordinary
Settings selection and closed-inline behavior retain their existing semantics.

Each file is `{source, name, bytes, sha256}`. Settings `source` is an explicitly
authorized canonical absolute file; plugin `source` is a literal relative name
inside that exact installed package. The captured descriptor bytes are bounded
and compared with expected size and SHA in the same capture, never by hashing
and reopening. Files must be regular, non-symlink, and single-link. Complete file
identity and traversal identity are checked before and after reads. Ancestor
`lstat` plus final `O_NOFOLLOW` is not an atomic OS fd-walk; acceptance proves the
expected captured bytes and checked identities, not absence of every ABA race.

`context` is exactly `{cwd, settingsScope, profileName}`; `definitionCwd` is the
original Hook cwd or `null`. `launch` is `{interpreter: "node" | "sh", entry,
argv, cwd?}`. `entry` must be a manifest file, and `cwd` must be `"."` or an
explicit declared snapshot directory, including an empty directory. Relative
names cannot escape, collide, or cover each other's ancestors. No original Host
cwd is mounted. The actual immutable-image Node path/hash and `/bin/sh` are the
only interpreters; fixed Node heap flags precede the entry, and every plan argv
follows it as literal data. Plugin root aliases refer only to `/resources`;
plugin data and HOME remain private scratch.

Unknown fields are rejected. Limits are 32,768 UTF-8 bytes for the entire native
JSON, 16 plans, 64 files and 64 declared directories per plan, and 256 files and
directories across plans. A file is at most 8 MiB; expected bytes across plans
(including repeated files) total at most 32 MiB. Launch argv has at most 32
strings, 1,024 UTF-8 bytes per argument and 8,192 bytes total, without NUL.
Source, plan, content, layout and launch identities are immutable for this native
lifetime. Invalidated custody stays invalid until a new Host; it is not recaptured.

Native caches retain only native plan/file/config custody. Current owner, signal,
grant and Settings authority are fresh for each review and never retained by a
shared resource callback. Initial source custody verifies full RAW bytes; later
native callbacks check complete metadata, while each current-review policy check
loads fresh RAW configuration and each resource revalidation rereads its bytes.
Readonly migrations pair data with the same stable RAW origin; unproven rereads,
persistent writes or invalidation clear resource provenance. UTF-8 BOM JSON is
still rejected as by the ordinary loader. A selected higher layer without usable
provenance blocks lower resource origins while preserving ordinary inline data.

The issuer excludes finite known credential containers under captured native
HOME/temp/userData/state roots, including the actual `CODE_SHELL_HOME/serve/`
runtime-secret and project-control containers. Existing root aliases are
canonicalized, with safe handling of missing suffixes. These rules do not inspect
file secrets or detect arbitrary server `--data-dir` locations. Ordinary plugin
scripts under `.code-shell` remain eligible for explicit grants. Unsafe initial
root custody disables only resource plans; approved closed-inline still works.
Later native writer-root/userData drift disables resource authority permanently
for that Host lifetime, including after the ambient value is restored.

Arbitrary shell dependency discovery, automatic plugin file grants, undeclared
scripts/imports/Host cwd, other interpreters and native macOS/Windows backends
remain unavailable. This finite opt-in does not complete a general untrusted
Runner platform or all existing Hook compatibility.

## Execution and acceptance

The five actual tool events are `pre_tool_use`, `on_permission_check`,
`on_tool_start`, `on_tool_end` and `post_tool_use`. Selection preserves existing
settings/plugin priorities, matchers and disabled/approval semantics. A private
failure/denial latch survives Registry exception swallowing, `allow`, `stop`
and child-controlled `data`. The pinned Link input and protected tool context
cannot be changed, including to `null`, `false`, zero or an empty string.

Each invocation receives a private scratch cwd, HOME, temporary directories and
plugin data. Its read-only mounts contain only the immutable bootstrap and
explicit resource snapshots. No Host HOME, credential directory, Docker socket,
operator environment, persistent writable directory or inherited Host file
descriptor is passed to the Hook. The root filesystem is read-only, the
unprivileged UID has no capabilities, and the pinned seccomp policy denies
socket/socketcall, io_uring and ptrace syscall families. Captured-stdio child
spawn can fail with EPERM under this policy; this is a compatibility limitation,
not a reason to weaken the policy.

Opaque permits are valid only in their issuing Host scope. Normal exit,
cancellation, timeout and Main disposal all require actual container kill when
needed, wait, `Running=false`, PID zero, no running descendants, removal and
confirmed absence. No observation is accepted before cleanup completes. An
unproven cleanup remains unavailable and blocks Main's graceful quit completion.
One narrow pre-create failure is distinguishable: the pinned CLI rejects an
invalid `--mount` CSV field in its client-side parser, before issuing a create
request. When the exact owned name is also confirmed absent and no container ID
was ever obtained, the scope can release its scratch. Other CLI errors,
transport uncertainty, timeout, or losing an already obtained ID remain
unproven even if a subsequent inspect currently reports absence.

A pre-Hook rejection sends no provider GET. A failure after the provider read
rejects that result and does not send a replacement GET. Hook prose never
becomes provider evidence. Read-only Settings migration uses one already loaded
trusted snapshot and does not write migrations or backups. Configuration files
retain complete identity checks; containing directories pin dev/ino/mode so
unrelated state children do not spuriously revoke unchanged policy.

## Reproducible synthetic checks

`scripts/smoke-constrained-hooks.mjs` is opt-in and requires an explicit runtime
JSON path plus evidence directory. Launch it with
`scripts/run-isolated-node-smoke.mjs` after a completed package-release build.
It exercises the compiled Node reader and actual owned Docker containers with
synthetic files, account metadata and exact-origin HTTP only. The kernel probe
contains no JavaScript network mocks. The normal guarded suite covers policy,
input and migration semantics separately and is not OS isolation evidence.
`scripts/smoke-constrained-hook-cleanup.mjs` separately exercises actual CLI
parser rejection, pre-create resource/image failures, lost container identity
and a private Unix fault proxy holding one create request until the real CLI
times out. The proxy's only forwarding destination is the explicitly configured
local daemon; it does not expose an Internet or provider transport.

`packages/desktop/scripts/e2e-operation-read.mjs` accepts the same optional
runtime JSON path, with `--resources` for finite Node/sh Settings and actual
installed/approved-plugin acceptance, or `--resource-bounds` for 64 files near
the 32 MiB aggregate limit and a shared Settings source near 4 MiB. It sets the native startup variable before production Main
loads, then uses the existing activity UI/IPC and a real compiled original
uncertain operation. Controlled native approval answers and synthetic provider
custody are fixture inputs; no real account, provider or paid model is used.
The fixture pre-seeds offline first-run plugin markers and denies external
Git/provider/shell launches. Its one allowed Git invocation is Main's exact
local `rev-parse --path-format=absolute --git-common-dir` owner query using the
system Git and private non-interactive config. These Host test guards are not
an OS sandbox for arbitrary Host child processes.

`scripts/smoke-hook-resources.mjs`, `smoke-hook-concurrent-typed.mjs`, and
`smoke-hook-resource-bounds.mjs` are guarded compiled-Node fixtures for finite
selection/custody, concurrent reviews and actual different-SID descendants,
and bounded-content performance/cancellation. The near-limit checks report
descriptor byte I/O, Settings/capture/resource synchronous slices, timer gaps,
and cancellation latency. Repeated verification has material synchronous CPU
and I/O costs; these limits are ceilings, not a responsiveness guarantee.
Host memory for snapshots, fresh configuration parsing and verification is
separate from the container's 192 MiB limit; cumulative Host RSS is reported.
Main measurement covers the review interval after Main is ready, with a separate
launch-to-ready wall time, not the entire cold startup. CPU profiles are sampled
diagnostics, not precise per-function elapsed-time guarantees. All measurements
retain the existing deadlines, lifecycle proof and current authority checks.

The 2026-10-09 synthetic acceptance used the existing Linux arm64 Docker image
with Node 22.23.2. Compiled Core ran on Host Node 25.8.1; actual Electron 33.4.11
Main ran on its embedded Node 20.18.3. These are distinct runtime observations,
not a claim about an untested Node minimum or a packaged installer. The actual
Main consumer used startup environment configuration and the existing Activity
IPC, including cold restart and sticky late native state-root rejection.

One plan declared 64 files totaling 33,550,345 bytes, with a 4,190,441-byte shared
Settings source. The measured positive intervals had no synchronous fixture
Docker observer:

| Measured interval                        | Core reader, one GET | Main Activity, two GETs |
| ---------------------------------------- | -------------------: | ----------------------: |
| Elapsed                                  |               5.73 s |                 14.75 s |
| Settings descriptor bytes read           |             176.0 MB |                389.7 MB |
| Resource descriptor bytes read           |              1.14 GB |                 2.65 GB |
| Longest 10 ms timer gap                  |               1.33 s |                  1.60 s |
| Cumulative Host peak RSS at interval end |          609,968 KiB |             577,376 KiB |

The Core reader's longest measured capture was 415 ms; reader construction took
728 ms and the immediately following synchronous read prefix took 570 ms. Main
performed 92 fresh Settings loads, totaling 2.23 s with a 58 ms maximum. Its
resource costs are CPU-profile samples rather than exact per-call slices. The
Main timer starts after readiness; startup-to-ready separately measured 1.88 s.
Host RSS values are cumulative process high-water marks, not interval growth or
container bounds. Forwarding instrumentation and CPU profiling add overhead.
The same near-limit Core fixture cancelled an actually running typed Hook and
confirmed cleanup in 221 ms after cancellation, without an additional GET;
that separate cancellation interval includes the fixture's synchronous Docker
inspection. These samples expose substantial Host costs and do not guarantee
maximum-size responsiveness. Shared-pass verification and other-platform
backends remain future work; the opt-in bounds and existing deadlines stay fixed.

The bundled seccomp asset is adapted from
[Moby profiles at its pinned source commit](https://github.com/moby/profiles/blob/6fe7deb1b9fb7c0397a4593480d7d22b9ee8caef/seccomp/default.json).
Its adjacent NOTICE and Apache 2.0 license are copied into the published Core
data assets with the policy.
