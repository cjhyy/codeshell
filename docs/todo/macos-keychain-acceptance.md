# macOS native request-key custody acceptance

The controlled local macOS run passed real Electron SafeStorage encryption,
Main-owned provider-wire HMAC verification, and recovery of the same persistent
material in a cold Electron process. This is local API/runtime acceptance of the
existing implementation; it is not an independent OS attestation, a signed
installer acceptance, a real provider bill, or a deployment.

The first successful run used test checkpoint `e6768bed801e232905f2ccfb21c56292eba59a57`
on source main `8dd491d0`. The task subsequently normally merged main `a535c8ed`.
The final combined native run at `1d961632b2e48a02f4c27ab50b2f28519f0da801` passed in
42.569 seconds: Main `30502`, worker `31032`, cold Main `32619`, ten local HTTP
requests, zero unavailable-custody sends and zero cold-restart sends. All local
package/build/type/helper/signing/lint gates passed again on that source. The
[combined acceptance receipt](macos-keychain-acceptance-combined-receipt.json) binds 58
new frozen raw files in two verified copies with manifest SHA256
`029b513749e5414d7deb163faf799a998ea905b980fd8fd2f1d806c6b90f960f`.
The [preceding acceptance receipt](macos-keychain-acceptance-final-receipt.json), its
314-file manifest, and the [earlier receipt](macos-keychain-acceptance-receipt.json)
with its 257-file manifest remain byte-for-byte unchanged. The later change runs the
Node-owned HTTP control assertion under a bounded real Node child when collected
by Bun and pins that Desktop CI shard to Node 22.16.0; affected Node/Bun helpers
and the native acceptance were rerun. The final normal main merge includes the
Session operation-controller binding and Desktop operation-review registration;
the package, workspace/Desktop builds, twelve typechecks, 93 focused tests and
actual Mac acceptance were repeated against this combination.
The documentation head `6b8bf1d6` passed all twelve required jobs in
[CI 37886572303](https://github.com/cjhyy/codeshell/actions/runs/37886572303).
The later normal merge of main `f08bbb9c` carries only TODO and delivery-document
updates. Its runtime, fixture, workflow and dependency blobs remain identical to
the exercised `1d961632` source; the native evidence keeps its original source
identity. Subsequent delivery edits are documentation/evidence only. No production
signing, cipher, transport, or user interface was changed.

## What the native run proves

- Actual Node 22.16.0 launches the real Electron 33.4.11 Main, production renderer,
  preload, AgentBridge, actual stdio worker, Core, and a local synthetic HTTP
  provider. The first run requires a real worker and verifies its PID/PPID.
- The synchronous pre-Main preload sets the actual app name to `code-shell` and
  removes Playwright's `use-mock-keychain` and `password-store` switches before
  native cryptography initializes. Main checks the effective switches.
- Main uses native `safeStorage.encryptString`/`decryptString` for a synthetic
  round trip and for its private production signing-key records. It verifies
  owner-only modes and the `host-encrypted` / `enc:safeStorage:` records, then
  independently recomputes wire, system, and message HMACs against bodies actually
  received by the local provider. Decrypted key buffers stay in Main and are
  zeroized there. No key is returned to the renderer or parent.
- The run has five logical boundaries, six physical attempt anchors and one
  encrypted key record. Plain streaming, a real read-only tool call, cache usage,
  and the scripted 429 retry pass. Auxiliary title requests are also local.
- Failure injection returns false from the same Main SafeStorage availability
  method. The first run's real terminal state and durable title callback are
  observed before injection; the exact total HTTP count remains unchanged while
  the existing signing error is visible. This does not filter unrelated requests
  out of the zero-send assertion.
- Main exits and a different actual Electron PID opens the same private HOME,
  app state and userData. It decrypts the persisted ciphertext and key records,
  verifies the original captured wire HMACs again and obtains the identical key
  record digest, without another provider request. Cold Main does not naturally
  create a worker; that absence is recorded. Every worker actually created must
  have its guard receipt; the first-run requirement remains strict.
- Files, browser, review and terminal panels mount through the existing UI and
  Settings opens. This adds no page, sidebar, account or product capability.

On macOS Electron does not expose the Linux-only selected-backend API. The
receipt reports `backend: null`, together with the native round trip and cold
verification, rather than inventing a backend name. Electron's
[versioned SafeStorage contract](https://github.com/electron/electron/blob/v33.4.11/docs/api/safe-storage.md)
and [native binding](https://github.com/electron/electron/blob/v33.4.11/shell/browser/api/electron_api_safe_storage.cc)
support the platform interpretation. They do not provide independent OS
attestation of this machine.

## Private HOME and the existing OS default

All launcher, Main and worker HOME/USERPROFILE, CodeShell state and Electron
userData are private; inherited Host configuration and provider credentials are
removed by the existing allowlist. The synthetic credential names only the
fixture server. A private HOME does not create an isolated macOS Keychain.

Seven earlier attempts exposed a specific fixture error: private HOME had no
default-Keychain metadata. Main blocked inside `isEncryptionAvailable`, and a
single owned-process stack sample showed Security's `defaultKeychainUI` path.
Metadata-only `security default-keychain -d user` succeeded in the ordinary
environment and failed in the private HOME. Apple's
[StorageManager implementation](https://github.com/apple-oss-distributions/Security/blob/main/OSX/libsecurity_keychain/lib/StorageManager.cpp)
can enter login-Keychain creation/reset UI when no default exists; this was not
evidence of a denied existing item or a request to click Allow.

The test-only correction captures only the existing default's absolute path and
regular-file identity. For each fresh private HOME it creates a new `0600`
preference, bounded at 1 KiB (337 bytes on this machine), containing only a `DefaultKeychain` singleton pointing
at that existing path, with the public AppleCSPDL GUID and subservice type 6.
It copies no search list, preference file, Keychain database or item. The
[Apple preference parser](https://github.com/apple-oss-distributions/Security/blob/main/OSX/libsecurity_keychain/lib/DLDBListCFPref.cpp)
defines this metadata shape; the GUID and service bits were also checked against
the installed public Security SDK headers.

Before Electron launches, both the parent HOME and the actual nested Electron
HOME must resolve through the real `security default-keychain` command to the
same existing path/device/inode/owner as the ordinary environment. The ordinary
metadata is rechecked after each binding and after the successful run. Receipts
retain only hashes and consistency results. A mismatch fails before launch.
Existing preferences and symlinks are refused. Cold restart reuses this same
private configuration. No `security` setter, unlock, item enumeration, password
lookup, operator preference write or OS UI automation is used.

Capture the metadata reference immediately before use. A later attempt rejected
a stale inode before spawning Electron, although the default path and owner were
unchanged. The cause of that file-identity change was not established; the guard
was not loosened. A fresh metadata capture and the final run's before/after
identity checks all passed.

## Transport and process scope

Before Core imports, parent, Main and each actual worker run seven negative
probes against the exact-origin fetch/http/https guard. Worker protocol input
remains corked until its receipt has been checked. This is JavaScript transport
instrumentation, not raw net/tls, Chromium or OS network confinement.

Playwright itself needs native WebSocket control. The parent permits only a GET
upgrade to an exact active endpoint observed on the owned Electron child's
stderr, tied to its executable, entry and HOME. It reconstructs native transport,
rejects custom routing and arbitrary loopback targets, and revokes the endpoint
on child exit. This exception is not installed in Main or worker. Cleanup tracks
PID plus birth identity; PID reuse cannot authorize a new process or descendants.
The launcher has a 180-second deadline and kills only still-matching owned
processes. Genuine OS authorization is never automatically handled.

## Preserved failures

| Attempt | Result retained without reinterpretation                                                                                                                                        |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1       | Launch failed before Main/OS evidence; initial smoke cleanup was not reached.                                                                                                   |
| 2       | Parent HTTP guard blocked Playwright's inspector transport; corrected by the exact owned-endpoint exception.                                                                    |
| 3       | Legacy recent-project data did not register a project in the current registry.                                                                                                  |
| 4       | 180-second deadline after project setup; no precise original blocking phase established.                                                                                        |
| 5       | The project name matched three UI elements; narrowed to the actual sidebar button.                                                                                              |
| 6       | The private project's application trust dialog blocked navigation; ordinary trust flow corrected.                                                                               |
| 7       | Actual native availability call blocked with missing private default metadata; owned sample and metadata comparison retained.                                                   |
| 8       | Native availability passed, but the zero-total-request assertion failed; no original per-request receipt exists, so its exact cause remains unproven.                           |
| 9       | Main/worker, zero-send injection and real HMAC verification passed; cold Main created no worker and the harness incorrectly required one.                                       |
| 10      | Full native API, zero-send, wire HMAC, cold restart, persistent identity and existing panel smoke passed; all owned processes exited.                                           |
| 11      | The normal main merge passed the same full native acceptance and all owned processes exited.                                                                                    |
| 12      | Stale metadata file identity failed preflight before any Electron or worker was spawned; same path/owner, inode change of unproven origin.                                      |
| 13      | Final source including the bounded Node control-test bridge passed full native acceptance and before/after metadata identity checks; all owned processes exited.                |
| 14      | Normal main `a535c8ed` combination passed a newly built full native acceptance with distinct Main/worker/cold Main and unchanged ordinary metadata; all owned processes exited. |

Attempt 8 is not reclassified as a pass. Subsequent instrumentation proved the
availability wrapper was used and no cached key bypassed its check. Waiting for
the previous run's actual terminal/title completion removes the demonstrated
measurement window without weakening the zero-total-send condition. No production
fail-closed defect was established by that failed attempt.

The first explicit Bun collection probe retained a separate failure: Bun 1.3.11's
`node:http` client shim rejected the 101 upgrade that actual Node and Electron
had passed. The test keeps every GET-upgrade and denied-target assertion. Under
Bun it launches actual Node >=22.16 without a shell or fallback, inherits the
shard's private environment, and checks the child's real executable/hash,
version, PID/PPID and HOME hash. Its 10-second deadline sends TERM, then KILL on
the same child handle and awaits terminal cleanup. Both final Node and Bun
helper combinations pass thirteen tests with zero failures/skips on macOS.

The first PR CI at `a369e423` preserved one further environment failure: its
new Node 22.16 floor exposed an existing pure Node fixture that directly imports
`link-loopback-callback.ts` without enabling TypeScript stripping. That child
failed before its product assertions; the other eleven jobs, including Electron
E2E, passed. The test now supplies `--experimental-strip-types` explicitly and
retains all shutdown/listener assertions. On private Node 22.16, the original
case plus helpers passed 22 tests, and the same full Desktop shard passed 4,829
tests with 69 existing skips and zero failures before the normal main merge.
The final combined focused shard passed 93 tests with zero skips/failures.
The original CI job log and run metadata are in the new frozen receipt; neither
this failure nor earlier failed attempts are relabeled as passing evidence.

## Reproduction

Use actual Node 22.16.0. Complete `bun run test:package-release`, workspace build
and Desktop build before reading the compiled packages. The first command is an
explicit metadata-only exception in the ordinary OS session; it imports no Core
and reads no credential or item. Use a fresh private `0700` directory and never
reuse an output directory or append to previous evidence.

```sh
node packages/desktop/scripts/macos-keychain-context.mjs --capture /private/tmp/PRIVATE-ROOT/reference.json
node scripts/run-isolated-node-smoke.mjs packages/desktop/scripts/run-macos-keychain-acceptance.mjs --default-keychain-reference /private/tmp/PRIVATE-ROOT/reference.json --output /private/tmp/NEW-ACCEPTANCE-ROOT
node scripts/run-isolated-node-smoke.mjs packages/desktop/scripts/macos-keychain-context.test.mjs
```

The last command runs the Node test module in a private environment. The
accompanying receipts record the exact commands used for all thirteen Node tests
and the final native repeat. POSIX ownership and
mode cases explicitly require that platform contract; the XML-shape test is
portable. None of these fixtures requires a real provider or account.
