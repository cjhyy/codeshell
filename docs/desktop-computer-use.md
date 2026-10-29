# Desktop Computer Use helper

CodeShell's macOS desktop automation uses **CodeShell Computer Use.app**, with
bundle identifier `com.cjhyy.codeshell.computer-use`. Accessibility and Screen
Recording belong to this helper. The main `code-shell` application displays
settings and owns the runtime lifecycle.

## Process and permission ownership

```text
CodeShell Electron main
  └─ helper CLI bridge: launch serve --socket <private socket>
       └─ LaunchServices opens the exact CodeShell Computer Use.app
            └─ cua-driver serve --embedded --socket <private socket>

Agent worker
  └─ cua-driver mcp --embedded --socket <private socket>
       └─ connects to the helper-owned daemon
```

LaunchServices establishes the helper's separate macOS TCC responsibility.
The helper directly starts the embedded driver so both share the helper's
permission identity. Moving an executable into an `.app` while continuing to
spawn it directly from Electron would not establish this separation.
Permission status checks and permission requests must execute inside the helper;
Electron's `systemPreferences` would report the main application's grants.
The MCP process only forwards requests and never owns desktop execution.

The driver remains in `standard` mode. The helper controls its embedded settings
and bundle identity; these are not agent arguments. The main process publishes
the MCP declaration only after the private daemon socket accepts connections.
Stopping the helper closes the daemon and its MCP connections. After a crash,
the runtime may start a new generation, but it never replays an interrupted
action automatically.

See the upstream
[embedding contract](https://github.com/trycua/cua/blob/cua-driver-rs-v0.34.1/libs/cua-driver/rust/Skills/cua-driver/EMBEDDING.md)
for TCC responsibility inheritance, and Apple's
[NSWorkspace launch configuration](https://developer.apple.com/documentation/appkit/nsworkspace/openconfiguration)
for launching a new instance at an exact application URL.

## Build and package locations

Development builds create:

```text
packages/desktop/out/native/CodeShell Computer Use.app/
  Contents/Info.plist
  Contents/MacOS/codeshell-computer-use
  Contents/Resources/cua-driver
```

Packaged builds install the same bundle inside
`code-shell.app/Contents/Library/CodeShell Computer Use.app`. The helper and driver
must be executable and signed before sealing the outer application. The driver
version and download checksum remain pinned in `resources/cua-driver.lock.json`.

The runtime resolves only these build-owned locations. A Homebrew installation,
an unrelated `cua-driver` on `PATH`, or the former `CODESHELL_CUA_DRIVER_PATH`
override does not replace the helper. Build it through the desktop development
or build command, or directly from the repository root:

```sh
bun packages/desktop/scripts/build-computer-use-app.ts
```

## Existing installations

The old `code-shell` Accessibility and Screen Recording grants do not transfer
to the new bundle identifier. Enable Computer Use in CodeShell's settings and
use its permission controls to grant **CodeShell Computer Use** access. Follow
the restart control after changing grants so the helper and driver refresh their
cached permission state. Existing main-application grants are not reset or
removed automatically.

## Verification

Run the simulated lifecycle integration suite from the repository root:

```sh
node scripts/run-bun-test-shard.mjs --timeout 30000 tests/computer-use-cua-integration.test.ts
```

Each scenario runs with an isolated HOME and denies network access except its
private Unix socket. The simulated helper launches the driver with the fixed
helper identity. The suite covers MCP images, delayed readiness, cancellation,
disabling active sessions, and daemon crash recovery without repeating a click.
It does not launch native applications, grant permissions, or establish actual
macOS TCC attribution.

Run the native lifecycle smoke on macOS:

```sh
python3 packages/desktop/scripts/smoke-computer-use-helper.py
```

This test creates a disposable working directory and isolated `HOME` and
`TMPDIR` before executing any native code. It compiles a test-only Channel entry
point to check invalid paths, ownership, replacement inodes, and symlinks; no
self-test command is included in the shipped helper. It then signs a temporary
helper bundle with an inert driver fixture and exercises real LaunchServices
launches, permission status reads, bridge termination, bridge `SIGKILL`, and
helper `SIGKILL`. The fixture checks environment filtering and exits when its
parent-liveness stdin closes. No permission requests, screenshots, or UI actions
are performed. Status reads return existing OS grants; they do not prove that
capture or input works. Never run ad hoc native fixtures from a repository or
another non-disposable working directory.

Check a finished macOS package separately:

```sh
bun packages/desktop/scripts/verify-computer-use-package.ts /path/to/code-shell.app
```

On the target macOS version, verify the signed installed application manually:

1. Open Computer Use settings. Merely reading status must not request a grant.
2. Request Accessibility and Screen Recording. The system entries and prompts
   should identify **CodeShell Computer Use**.
3. Grant both, restart as directed, and run an explicit observation and a simple
   Calculator action. Verify readable pixels and successful input; a permission
   status alone does not prove capture works.
4. Revoke a helper grant and verify the main application's existing grants do
   not make helper operations succeed. Restore it and restart.
5. Disable Computer Use and quit CodeShell. Verify the helper, daemon, and their
   socket are gone. Repeat with the helper terminated unexpectedly to check
   recovery and confirm an interrupted action is not repeated.

Record the macOS version, installed path, signing identity, and observed entries
with the package validation result. A simulated test or successful build is not
a substitute for this platform check.
