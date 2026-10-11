# Panel stable project context

The Host supplies an optional `context.projectScope` with exactly
`{version:1, environmentId:string, projectId:string, rootId:string}`. It is
available only to an app with `context.workspace` after authoritative project
resolution and execution-root verification. It introduces no permissions or
Guest-supplied authority fields.

## Authority and lifetime

- Desktop resolves an exact registered root and rechecks the same project/root
  IDs through `ProjectStore.resolveProjectRootByIdSync`. Git common-directory
  and worktree topology use the existing frozen Hub binding verifier.
- Native Desktop and paired Web use one Main resolver and the same environment
  at `join(codeShellHome(), "desktop")`. Paired Web cannot invent an independent
  environment or derive identity from a session ID.
- Hub uses its advertised environment descriptor and frozen authorized binding.
  Its project ID is opaque; every execution root has a distinct opaque root ID.
- Root IDs incorporate canonical directory identity, device, inode, and bigint
  birth time. Directory, environment file, registry, and topology checks repeat
  on bind, context reads, and Host calls. A failed proof is permanently revoked;
  deletion/recreation or same-path mount replacement cannot revive an old guest.
- Asynchronous native binds have a per-guest generation and cancellation signal.
  A superseded bind, closed guest, changed window, or changed selected descriptor
  cannot overwrite a newer session or storage bucket.
- A native guest freezes its first real session separately from project access.
  Session replacement or loss permanently rejects `agent.submitPrompt` and
  `automations.*` with `SESSION_CHANGED`, including A → B → A. The barrier runs
  at actual Main dispatch and after async automation lookups or runtime context
  loading. Project context, file/process calls and independent tasks retain
  their existing permissions and project ownership.
- Native calls revalidate scope and live guest before returning awaited results.
  Workspace writes recheck after queueing and staging, pin the physical root and
  parent directory, and check immediately before synchronous link/rename.
  Legacy storage writes pass the existing writer's authorization callback.
  Both legacy and versioned storage also provide a synchronous fence after the
  writer's final filesystem preparation and immediately before rename. Web
  runtime services forward the same fence from the live grant and project proof.
  Production automation calls use the guarded shared Host, with a synchronous
  transport fence immediately before scheduler mutations after authority awaits.
- Web grants already freeze the session at prepare. Their existing session and
  owner checks remain in force; the project proof is attached to that grant and
  revalidated before and after asynchronous authorization.

Unregistered Desktop roots and older Hosts omit the new proof. Consumers must
keep conservative session behavior when any of its four fields is missing or
invalid. Existing storage layout, app permissions, automation definitions and
independent-task semantics remain compatible.

## Validation

The source-only checks use the repository's guarded Bun runner, a private real
HOME, and explicit network guards installed before dynamic Core/Host imports.
Pure filesystem tests deny all network calls. HTTP fixtures permit only their
owned server origin. Both guards execute negative fetch and HTTP probes.
`src/**/__fixtures__/**` is excluded from the server production tsconfig, so
test isolation helpers are not shipped in its published `dist`.

The tests cover actual filesystem mount replacement, environment-file
replacement and nonregular metadata, registered project/root changes,
multi-root projects, real Git worktrees and forged topology. Native bridge
tests execute the actual Main methods extracted through the TypeScript AST in
a VM, with Electron startup replaced by owned fixtures. They cover superseded
binds, closing during an unresolved bind, authorization after await, and a
successful context precheck followed by Main rebind before event delivery:
all session-sensitive dispatches have zero raw side effects. Async automation
lookup and external-runtime context races also have zero mutation/send effects.
Deferred native responses are refused after scope/guest/shutdown revocation.
Real queued and staged filesystem writes are refused after root or parent
replacement and registry revocation; the replacement directory receives no
target file. Ordinary file creation and replacement still pass. The real
automation Host rejects native rebinding during durable authority lookup with
no scheduler job created; the final authorization-await fence is also probed.
The actual storage writer's final asynchronous prepare is held while guest or
registry authority is revoked; native set/delete/compare-and-set preserve the
original file in all six cases. A real HTTP runtime repeats the final-prepare
race with a replaced project root and preserves its original stored value.

These guards reject detectable changes at the publication boundary. They do
not roll back a completed write or claim operating-system atomicity across
separate path checks and filesystem syscalls. A staged temporary file in a
directory that was moved away is intentionally not cleaned through a replaced
path.

Two real HTTP fixtures exercise the shared runtime and Desktop paired facade.
They verify permission-gated disclosure, native/paired identity equality,
session-independent project identity, refusal of forged fields, unchanged
method permissions, and permanent rejection after mount replacement.

These checks establish source behavior and actual HTTP integration. Native
Electron UI interaction, full package-release/type/Desktop gates, merging,
deployment and publication are the integrating task's separate acceptance
steps; this delivery does not claim those steps have run.

### Integrated local acceptance (2026-10-12)

The combined Host/collection guarded regression shard passes 103 tests with
562 assertions, zero failures and zero skips. Package checks pass for nine
tarballs, 47 typed entrypoints and 45 runtime entrypoints. All 12 workspace
typechecks and the Desktop build pass. ESLint reports zero errors and the
existing 105-warning baseline. The compiled collection SDK acceptance passes
under Node 25.8.1 and Electron's Node 20.18.3; the existing uploads SDK and Core
export checks also pass. These checks do not exercise native Electron UI or
deploy an application.

The compatible Download and Video Studio changes are merged in
[Panel PR 69](https://github.com/cjhyy/codeshell-panel-apps/pull/69), with all
14 jobs across its push and PR CI runs successful. The Panel merge tree matches
the tested commit. Host [PR 134](https://github.com/cjhyy/codeshell/pull/134) is
merged with all 12 CI jobs successful at final head `456668b1`. This includes
the repository Electron E2E gate; it is not a dedicated physical-device or
provider acceptance of this new contract. v0.9.33 publication is verified
separately. No new Panel release or installation is claimed here.
