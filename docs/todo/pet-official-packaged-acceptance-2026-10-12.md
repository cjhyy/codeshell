# Official packaged Pet acceptance: blocked

The official signed macOS arm64 **v0.9.35** application started its own packaged
Main, preload, renderer and actual stdio worker. The first native
`safeStorage.isEncryptionAvailable()` call did not return. Pet produced no accepted
response and the local scripted provider received **zero requests**. This is an
incomplete P0 acceptance, recorded in the
[blocked receipt](evidence/pet-official-packaged-blocked-2026-10-12.json).

The earlier [compiled Desktop acceptance](pet-built-runtime-acceptance-2026-10-12.md)
remains a separate development-build result. It does not satisfy this official
package requirement.

## Evidence from the failed official run

The executable was the actual signed application downloaded from the official
GitHub v0.9.35 release. No development Electron binary, application-directory
argument, imported ASAR entry, rebuilt Host output or modified package was used.
Runtime identity assertions checked `app.isPackaged`, the application's own
`Resources/app.asar`, executable/resources paths and private userData before the
guarded-start log. The full identity object was not separately persisted in this
attempt; the delivered fixture now persists it for subsequent runs.

Main PID **9987** created worker PID **10003**. Both reported Electron **33.4.11**
and Node **20.18.3**, the same private HOME identity, the exact scripted model
origin, and **seven rejected HTTP/fetch transport probes each**. The production
worker actually runs the official Electron executable with
`ELECTRON_RUN_AS_NODE=1`. The separate bundled Node **24.21.0** is intended for
the fixed synthetic plugin; its bytes were verified, but that plugin process was
never reached in this run.

The worker's real Pet tool catalog contained `DelegateWork` and the other nine
manager tools. It exposed no execution or MCP tool. This proves capability
loading, not a completed Pet interaction.

Native instrumentation records only method entry, return or throw and calls the
unchanged native function. Its sole record was entry into
`isEncryptionAvailable`, with no return. A one-second sample of the captured
owned Main found 90 samples through `SecKeychainFindGenericPassword`, the
Security Keychain item/data path, `SecurityServer::ClientSession::decrypt` and
`mach_msg`. This establishes a native Security server wait. It does **not** prove
whether an authorization dialog, a locked Keychain or another OS condition
caused the wait. No system authorization was clicked, Keychain unlocked, default
or search list changed, credential item directly inspected or native cryptography mocked.

The Pet deadline was 20 seconds. Graceful Main close then exceeded its five-second
deadline. The primary timeout and shutdown failure were both retained. Only the
captured Main and the existing identity-tracked owned Electron descendants were
subject to cleanup; no global process kill was used. A later read-only process
check found no owned executable/profile process alive. Application worker-exit
acknowledgements were incomplete, so the private HOME was retained rather than
deleted. The native fixture slot was explicitly released to the Panel acceptance.

## Official bytes and signatures

The original ZIP still hashes to:

```text
c492b4de7b45d8977b81414701d7e5d8b900038df9be8166cda6e3c71daf579e
```

After shutdown, a fresh independent extraction of that unchanged ZIP was compared
with the application that had executed. Their complete deterministic inventories
match: **227 directories, 729 files, 14 symbolic links**, including directory/file
modes, file sizes/content hashes and link targets. Both pass
`codesign --verify --deep --strict`. The tree digest is:

```text
a44a509c03fbe09c296813b24da6da1b6430e0561636926bb8e99fb1c912bd8f
```

The ASAR digest is
`e85ba327b918f513cb9cc227109fbf3456fcff1a3329706ad9443dcbf8d8256b`;
the bundled Node digest is
`f2dc64c64e9b5bec2c633e79406ab16f8a8eb864b23c64c61091ad28e28d3288`.
These checks establish equality with the original release archive after the
failed run. The attempt's prelaunch inventory was held only in memory and lost
when it failed; the receipt explicitly identifies the fresh-extraction comparison
as its baseline. The delivered fixture now writes the prelaunch baseline before
starting Electron and verifies integrity on failed runs too.

## Fixture boundary and verification

`packages/desktop/scripts/e2e-pet-packaged.mjs` is a separate official-package
fixture. Packaged Electron filters ordinary `--require`/`NODE_OPTIONS` preloads.
The fixture instead captures its own spawn and connects only to the inspector
endpoint emitted by that child. It requires the runtime's initial
`Break on start` pause in the packaged Main graph, synchronously requires a
private bundled CJS guard, then resumes. The actual pause was at line/column zero
of the first Main chunk. Three Host scripts had been parsed; parsing is not
claimed to be absent. A real owned Node ESM test verifies that this initial pause
precedes both a static dependency's body and the entry body. A later pause or
failed guard terminates the captured child before disconnecting the inspector.

Each actual worker receives that guard before its entry, with stdin corked until
PID/PPID, executable, runtime and HOME/origin probe receipts are checked. Main's
Chromium session filters requests separately. These are JavaScript HTTP/fetch and
Chromium request guards, with no raw net/tls or OS sandbox claim. The fixed
synthetic plugin has its own HTTP-denial fixture. All provider inputs and
credentials are synthetic and the intended provider is an exact loopback server.

Future success requires real native availability/encrypt/decrypt returns, two Pet
inputs in the same durable Session, normal Work continuation, installed synthetic
MCP initialization/tool discovery without tool calls, and a cold application
restart recovering Pet history/memory. None of those completed assertions is
marked passed in this blocked receipt. Real WeChat delivery, operator plugins and
automatic Pet delegation/continuation are outside this synthetic acceptance.

The final fixture refinements passed **15 guarded tests, 57 assertions, zero
failures** across startup pause, guard, full-tree inventory and shutdown helpers.
The tests include real owned Node CJS/ESM processes, rejected startup barriers,
wrong HOME/storage/executable/origin, equal-size file rewrites, directory modes,
framework aliases, corrupt exit proof, close failures and removal failures. Real
owned WebSocket children also verify that malformed inspector JSON or message
shape errors terminate the captured child before inspector disconnection.
Targeted ESLint, Prettier and Node syntax checks passed. Those refinements were
not rerun with native Electron after the native slot was released.

## Resuming the acceptance

Resolve the existing OS wait and obtain the shared native fixture slot before
another run. Use the existing metadata-only binding in the ordinary OS session,
never a mock/basic keyring or a modified signed application. The fixture does not
handle system authorization dialogs. Use a fresh metadata reference and receipt;
the reference pins the existing default Keychain's file identity and fails closed
if it changes.

```sh
task_keychain_dir=$(mktemp -d /tmp/codeshell-official-pet-ref.XXXXXX)
node packages/desktop/scripts/macos-keychain-context.mjs --capture "$task_keychain_dir/reference.json"
node scripts/run-isolated-node-smoke.mjs packages/desktop/scripts/e2e-pet-packaged.mjs --official-app /absolute/path/to/code-shell.app --default-keychain-reference "$task_keychain_dir/reference.json" --receipt "$task_keychain_dir/runtime-receipt.json"
```

This fixture requires installed development dependencies but does not build the
Host. Keep frozen artifacts and the signed app unchanged. A nonzero exit or
`status: failed` receipt must not become a release acceptance. Retained private
HOME paths and diagnostic log hashes are in the blocked receipt for local audit.
