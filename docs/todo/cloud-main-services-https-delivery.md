# Desktop Main / Account / Cloud HTTPS interoperability

The actual Desktop Main Account and Cloud managers and their Node HTTPS transports
completed registration, Account ticket issuance, Cloud redemption, and project
list/create/start/open/stop against the actual Services Account service, Services
Cloud authority adapter, and tarball-extracted Server controller. The final run
used Node 22.19.0 with strict unhandled rejection handling.

The reproducible opt-in entry is `scripts/smoke-cloud-main-services.mjs`:

```sh
node scripts/smoke-cloud-main-services.mjs --run \
  --services-dir /absolute/path/to/codeshell-services \
  --packed-consumer /absolute/path/to/packed/consumer
```

Run again with `--fail-after-open` to verify cleanup after an intentional exception
following actual Main project start/open. That mode succeeds only when the child
exits with code 1, reports the expected injection point and completed cleanup,
and the parent has waited for exit and removed its private temporary tree.

Prerequisites are Node 22.16 or newer, Bun, OpenSSL, Git, a compatible clean
Services `apps/` checkout, and the five real tarball-extracted packages in the
consumer's `node_modules/@cjhyy/`. An adjacent `../pack-receipt.json` supplies the
original tarball paths, hashes and build inventory. The runner verifies all five
tarball hashes and every recorded `dist/` file, refuses workspace package directory
symlinks and build files escaping their package, and reads the inputs without
building or packing in either input directory. Bun compiles the four actual Main
exports into the private fixture directory; it does not replace their transports.

The runner creates a fresh real HOME and configuration directories, removes
inherited credentials/options, and generates two independent private CAs and
loopback HTTPS leaves. Native TLS verification remains enabled. Each Main
transport receives only its corresponding CA; wrong-CA attempts fail before
Account passwords or Cloud requests reach either server. Services' actual global
fetch trusts the fixture CAs through `NODE_EXTRA_CA_CERTS`.

The child installs the network/process guard before Main, Services or packed
Server/Core imports. Only its own loopback listeners mint permitted origins;
external fetch, unowned HTTP, disabled TLS verification and child process probes
all fail. Application subprocess execution is denied. The trusted parent only
builds the fixture, generates certificates and launches its one owned Node child.

The final successful run verifies:

- Existing explicitly adopted legacy projects retain their IDs. Main performs
  list/create/start/open/stop, and open produces exactly `/?project=<UUID>`.
- Main sends its root Account bearer only to the fixed Account ticket endpoint.
  Root access and refresh tokens never appear in any Cloud request or runtime DTO.
  Cloud session requests contain only `{ticket}`, without Origin, cookies, bearer
  or browser fetch headers. Account ticket requests use the fixed Account Host
  and Origin.
- A consumed ticket cannot be replayed. An incorrect installation pin and a
  foreign Account are refused.
- Actual Main Account logout reaches the real Account service. An independently
  issued Cloud grant subsequently receives 401, a captured Account lease becomes
  invalid, and Main refuses further management. A start paused inside the runtime
  provider cannot publish a late success and its newly started runtime is stopped.
- Both the successful run and the injected start/open failure settle pending
  operations, dispose Main managers, close windows, stop owned runtimes, close
  listeners/sockets and exit before parent cleanup. The child is run with
  `--unhandled-rejections=strict`; a 90-second parent watchdog bounds hangs.

The final component source includes root Cloud checkpoint `4c5a1934`; the tested
Host merge head is `0a48e3ba`, Services is `535fa38` (code `7465eae`), and the
verified packages were built/packed from Host `7ab0691c`. The JSON receipt records
full heads, tarball hashes and hashes of these four smoke source files. It contains
the two final Node 22 runs, including child exits 0 and 1 and confirmed removal of
each private fixture. The initial observer used a `data` listener that prematurely
flowed the request before Account's asynchronous routing installed its JSON
reader; the test observer now records emitted data without changing stream mode.
Those initial failed runs are not acceptance evidence.

This is interoperability evidence with a controlled runtime provider and an
injected window adapter. It does not assert Docker execution, physical mobile
acceptance, a production deployment, or Electron window custody. Native Electron
window custody has its separate smoke owned by the Desktop integration task.
The package version is an unreleased candidate, not evidence of a public release.
