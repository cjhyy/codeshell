# Three-repository native candidate readiness

This is a package-consumer checkpoint, not a release/deployment approval. Product
checkpoint `3a99c376facd8dd7130482515135b825211fade3` includes the controller lease,
restore durability, ticket-v2 Server and Desktop changes. The tested Host
`e01c4d7e2e63c9825d736ead0867081a217c91e0` normally merges it with the candidate
gate. Tested Services is `ef0f2b0c384f0392bb180c5b90bf1e4b68451268`, based on final
main `c06e6553`; its docs checkpoint is `c2e7dab`. Panels are exact
`41bb3638a2d8402debaa1a0d239078a55a0b25eb`.

## Completed local work

The existing independent Services candidate entry previously qualified its
legacy controller capabilities without running the new Account-owned Cloud
consumer. It also hit a test that always expected public 0.9.28. The entry now
requires the actual installed Account-v2 gate, ticket management and native
adoption CLI before continuing. Services retains its legacy 0.9.28 default pin;
the explicit Account check requires authority 2, adoption APIs and the packaged
executable CLI. Its version test verifies the installation's exact manifest and
lock instead of confusing an older fixed version with compatibility.

Five packages were clean-built, packed and freshly installed from this product
checkpoint on macOS arm64, Bun 1.3.11, native Node 24.19.0. Source, tar and build
inventory identities are recorded in [the receipt](cloud-native-candidate-readiness-2026-10-13.receipt.json).

| Verification                                         | Actual result                                                                                                                                             |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public 0.9.28                                        | Legacy gate passes; Account-v2 consumer refuses before controller initialization                                                                          |
| Public 0.9.35                                        | Legacy gate passes; Account-v2 consumer refuses despite sharing the candidate version string                                                              |
| New five-package installation                        | Exact manifest/lock and Account-v2 gate pass; actual ticket management and native adoption CLI pass                                                       |
| Damaged candidate missing CLI                        | Account gate refuses before management consumer                                                                                                           |
| Complete native candidate entry                      | 502/502 Services tests, zero skip; 23 controlled browser cases; settings recovery and actual Relay HTTP/WSS acceptance pass                               |
| Six Panel packages                                   | Actual installed Core read-only preflight passes all six exact committed package trees/digests                                                            |
| Actual Main + native HTTPS + Account + packed Server | Two independently trusted private CAs; root credential confinement, target/replay rejection, project controls, logout and late-operation fences pass      |
| Main post-start/open failure                         | Actual injected failure; runtime/window/listener/socket cleanup, owned child exit 1, then private fixture removal pass; normal path independently exits 0 |

The new Server tar SHA-256 is
`ede796019c644e833e18a04bc897856da485c51f4e083fc2aff1824fb0ef4e74`.
The preserved installation is
`/private/tmp/codeshell-final-candidate-gate-20261012/candidate-final`, with sibling
`pack-receipt.json` and real tarballs in `candidate-final/vendor/`. It is not an
OCI candidate archive. Main consumers used exact build inventory and tar hashes,
fresh HOME and guards before product import. The complete native entry also used
a fresh HOME/environment without operator/provider credentials; its browser and
upstream providers are controlled fixtures. No real third-party OAuth/model
acceptance is inferred from those browser cases.

Independent review also found an older consumer cleanup false-success boundary.
Services cleanup checkpoint `1a03de2` now independently aggregates controller,
runtime/listener/Account shutdown failures and preserves evidence, while the
launcher waits for `close` and preserves HOME after any stage fails or times out.
It normally integrates Services main `068c124`; the actual management/native CLI
normal consumer passed again from a separate copy of the unchanged five-package
installation. Both Main HTTPS paths also passed against the newly integrated
Account apps. The 502-test full-suite receipt above remains specifically tied to
`ef0f2b0`; it is not retroactively attributed to the later profile/recovery merge.

A private-copy wrapper awaited the actual backend close and then rejected its
Promise: current code exited 1 without `passed`, skipped the CLI phase and
preserved both reported evidence directories. The same fault on real historical
`ef0f2b0` management source incorrectly exited 0 and printed `passed`. The receipt
records both source/fault digests and outcomes. No product fault hook was added.
This is a returned shutdown-rejection check, not proof of every partial shutdown
or timeout. A timeout's CLI grandchild exit remains unconfirmed; preserving HOME
is intentional, and no successful cleanup claim covers that path.

## Release dependencies and target read-only state

Host public `v0.9.35` is already released at peeled tag commit
`8ce3d2c850ebd500023259fad8886a47fd9cf96a`; these new bytes are not that release.
A final new release must synchronize its version/lock, verify all **nine** public
packages and Desktop assets, and re-pin Services to the exact compatible
published package set or deliver an explicitly verified private candidate.
Services main still pins Server 0.9.28. Do not change that pin to the old public
0.9.35 expecting Account authority 2.

The six Panel candidates are Design 0.18.2, Job Hunt 4.1.2, Quant 0.46.2,
Download 0.22.7, Video 0.7.3 and Starter 0.1.1. Read-only GitHub release inventory
still shows public latest-per-Panel Design 0.18.1, Job Hunt 4.1.1, Quant 0.45.2,
Download 0.22.3 and Video 0.7.2, with no Starter release found. `/releases/latest`
alone is insufficient because it refers to Quant while Video has a later release.

Public target checks at **2026-10-12T16:12:11Z**, using normal TLS verification,
fixed `en0`, no proxy and no credentials:

- `https://115.159.45.55/health`: 200, `status: ok`, `mode: hub`.
- `/api/v1/account/status`: 200; registration/GitHub/GitHub-Link flags all true.
- `https://115.159.45.55:8443/health`: 200, Link schema 3.
- `/api/v1/cloud-management/capabilities`: 401, `login required`; no public v2 DTO.

The existing deployment records and prior root read-only probe identify Hub
0.9.23 and Account/Link source `c892b91b`, with Relay inactive. This task could not
refresh unit/package metadata over SSH: strict host verification did not find a
trusted key after binding the correct interface. It did not add trust, bypass
verification, read production configuration/databases/secrets or retry unknown
profiles. Public health cannot establish a running process's exact source bytes,
target architecture or deployment of the new Account Cloud route.

## Directly actionable local follow-up and remaining barriers

| Item                                       | Can proceed locally without phone/production mutation                                                                                                                            | Boundary still open                                                                                                                                                   |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Final package/installable preparation      | Build final version from a clean integrated checkpoint; run `test:package-release` before any other dist consumer; verify all nine tarballs and Desktop assets                   | Final version/tag/assets and native product acceptance remain under the root release task                                                                             |
| Runtime/Link image candidate               | Existing `--docker --output` flow builds, exercises and saves both images, all six Panel sources and their exact identities                                                      | Local Docker daemon was unavailable; no image or volume test ran here. Use a working local daemon or the existing Linux candidate workflow and verify target platform |
| Synthetic cross-version migration/rollback | Separate old/new package installations and synthetic data can run without real provider or target access; retain current authorization state and test fail-closed legacy readers | This package gate is not a full 0.9.23-to-final-to-old persisted-data/volume rollback exercise                                                                        |
| Target installation readiness              | Prepare exact private archive, backup/rollback runbook, explicit operator adoption inputs and origin/installation pins                                                           | Current task is read-only; target service/config/data changes and maintenance drainage were not performed                                                             |
| Cloud Account activation                   | Configuration contract and exact Nginx private verification route are documented in Services                                                                                     | Requires explicit trusted Cloud origin/installation UUID, independent secret and target routing; status flags and local HTTPS do not establish that configuration     |
| Panels / mobile / Pet                      | Existing local package and controlled runtime gates remain available                                                                                                             | Formal Panel assets/production update, full 24 business combinations, physical phone/background/weak-network evidence, and native Pet/Keychain acceptance remain open |

No publish, deployment, Keychain or real provider action occurred. The five new
native tarballs cover product `3a99c376`; a later product change or version bump
requires another clean build and consumer run. Earlier `7ab0691c` and pre-lease
tarballs are retained only as earlier evidence, never as the final product set.
