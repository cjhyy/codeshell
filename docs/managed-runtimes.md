# Application-managed runtimes

CodeShell Desktop supplies a private Node.js runtime as an application resource.
It is available even when the operating system has no `node` command. Supplying
the runtime and choosing to execute code with it are separate operations.

This feature supplies an optional Host capability. It does not select a runtime
for an existing consumer, edit the environment, install dependencies at startup,
or change process approvals. Existing Agent workers, Panel Apps, native tool
tasks, and `process.find("node")` retain their current behavior.

## Host API

Repository Hosts can import the provider from the internal Core entry:

```ts
import { createManagedRuntimeProvider } from "@cjhyy/code-shell-core/internal";

const runtimes = createManagedRuntimeProvider({
  root: applicationRuntimeResourceDirectory,
});

const installed = await runtimes.list();
const node = await runtimes.resolve("node");
if (node) {
  // A consumer may explicitly choose node.executablePath after applying
  // its own authorization, sandbox, and process-lifecycle policy.
}
```

`list()` returns verified runtime metadata without filesystem paths. `resolve(id)`
also returns `executablePath` and `binDirectory`. Neither operation starts a
process, downloads a file, modifies PATH, or grants permission to execute code.
Missing runtimes return `null`; invalid packages produce a specific error.
The internal Core entry is an in-repository Host API, not a stable public SDK.

Desktop's `createDesktopManagedRuntimeProvider()` supplies the resource location:

- Installed applications: `<process.resourcesPath>/runtimes`.
- Development: `<app.getAppPath()>/out/managed-runtimes`.

The trusted Desktop renderer can explicitly discover these resources through
`window.codeshell.managedRuntimes.list()` and `.resolve(id)`. This read-only API is
not exposed by the Panel guest preload and does not start a worker. Host sender
and main-frame checks reject calls from embedded guests.

## Package layout and validation

Each runtime has its own directory, for example:

```text
runtimes/
  node/
    manifest.json
    LICENSE
    bin/node          # bin/node.exe on Windows
```

The schema-1 manifest records `id`, exact `version`, `platform`, `arch`, the
relative `executable` path, the final executable's `sha256`, and a `source` object
containing the official archive URL and `archiveSha256`.

The provider validates the manifest, platform, architecture, contained regular
files, binary digest, and file identities across the read. Symlinked runtime
paths and path traversal are rejected. It never falls back to a system runtime
or another application's cache when a bundled runtime is missing or invalid.
Runtime identities and integrity metadata are descriptions, not approval grants.

## Build and release supply

`packages/desktop/resources/node-runtime.lock.json` pins Node 24.21.0 and the
SHA-256 of each official archive. The current release targets are macOS arm64 and
x64, Windows x64, and Linux x64. The build uses the target architecture rather
than the build machine's architecture.

From `packages/desktop`, prepare the development runtime explicitly:

```sh
bun scripts/managed-node-runtime.cjs --smoke
bun scripts/verify-managed-runtime.ts out/managed-runtimes
```

The first command downloads and verifies the locked archive, then extracts only
the executable and its license. The second uses the actual Host provider and an
empty PATH to check JavaScript modules, standard-library access, stdin, and a
child process launched through the selected executable.

Use `--platform`, `--arch`, `--cache`, and `--output` to choose a build target and
staging locations. `--download-only` prewarms the verified archive cache;
`--offline` requires that cache and never downloads. `--verify` checks an existing
staged runtime without replacing it. Development output and download caches are
excluded from application archives.

The Desktop packaging hooks supply `<resources>/runtimes/node` for each target.
`CODESHELL_NODE_CACHE` can select the build cache and `CODESHELL_NODE_OFFLINE=1`
requires a prepared cache. Missing archives, unsupported targets, invalid
checksums, or signing failures stop packaging. On macOS the manifest hashes the
Node executable after signing; subsequent application signing preserves those
bytes and the final hook revalidates them. The packaged runtime includes its
upstream license and attribution.

This is a build-time operation. Opening the application or querying a runtime
does not install anything. Updating the pinned runtime follows the normal
application release process.

## Consumer boundaries

Consumers opt in independently. A future Panel integration can expose an opaque
executable handle through its existing permission boundary; this feature does
not add that integration or advertise a Panel runtime method.

Node's presence does not imply npm, npx, FFmpeg, HyperFrames, browser binaries, or
models are installed. Those dependencies and their version requirements remain
with the consuming package. A consumer that needs child commands to find the
selected Node can explicitly use its `binDirectory` in that process environment;
the provider leaves both the Host and global environment unchanged.
