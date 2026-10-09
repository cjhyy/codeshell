# Configured Hooks in independent operation review

The existing Settings activity review can execute explicitly authorized, finite
inline tool Hooks through a native Host process capability. It does not create
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
existing operation review IPC. Its value is a JSON object with exactly these
fields:

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
Desktop currently admits a complete small literal grammar: `:`, `exit N`, and
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
`hooks.json` approval as permission to read all plugin files. Desktop currently
has no Agent Plugin resource-authority seam for arbitrary scripts and their
imports. Those Hooks, external cwd/resource dependencies and unconfigured
runtimes remain `hooks_unavailable`. Full existing Hook compatibility is still
unfinished.

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

`packages/desktop/scripts/e2e-operation-read.mjs` accepts the same optional
runtime JSON path. It sets the native startup variable before production Main
loads, then uses the existing activity UI/IPC and a real compiled original
uncertain operation. Controlled native approval answers and synthetic provider
custody are fixture inputs; no real account, provider or paid model is used.
