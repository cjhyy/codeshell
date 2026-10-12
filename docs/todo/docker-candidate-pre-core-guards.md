# Docker candidate fixture isolation — implementation checkpoint

Parent source: `13f31ccabb18e26531fbd468f294caaa1ffb0f27` (the normal
integration of candidate RPC/Run diagnostics). This is test infrastructure;
no DockerProvider, production image, Main, package version, or deployment
configuration changes are part of this checkpoint.

`docker-candidate-guard.mjs` installs HTTP/fetch, raw socket/TLS, DNS, UDP,
listener and process restrictions before a product entry can import Core.
The immutable policy pins a private HOME, preload and guard digests, exact
child executable/entry bytes, argv, working directory and inherited preload
environment. Every allowed child and its independently installed preload
produce PID receipts. Numeric loopback DNS lookup is allowed because native
Node calls it for a literal-address listener; hostname resolution is refused.

`docker-candidate-adapter.mjs` freezes the current production Docker CLI
contract rather than allowing arbitrary flags or a shell. It checks fresh
installation/project labels, generation, immutable image ID and an exact
loopback published-port binding before minting an HTTP origin. Starting a
container without the native egress adapter is refused.

The separate fixture-only Dockerfile uses the existing Services immutable
Node base and Debian's signed `20250301T000000Z` snapshot with
`iptables=1.8.9-2`. Debian's official bookworm package page lists that version:
<https://packages.debian.org/bookworm/iptables>. Dependency inventory and tool
byte hashes are written into the helper image; its actual built image ID must
be captured by the driver. This Dockerfile has **not** been built here.

The native helper joins only an immutable owned container's network namespace,
with all capabilities dropped except NET_ADMIN. Its rules set IPv4 and IPv6
OUTPUT to DROP, allowing established replies and exact loopback TCP ports
8790, 18791, 18792 and 18793. Both families are checked before an ACK can be
published. No host firewall or production runtime image is modified.

Validation on 2026-10-13: guarded Bun shard, 15 tests / 66 assertions / zero
failures. The guard fixture launches actual native Node entries and a real
loopback HTTP listener under a fresh private HOME, and verifies descendant
preload/PID receipts and refusal after preload mutation. The firewall tests
use a controlled command adapter to inject IPv6/verification/publication
failures; they do not prove actual kernel rules, Docker resources, or native
Panel business behavior. No local Docker, Core, Main, Electron, Keychain,
provider or paid model was launched.

Remaining integration: controller preload/registry adapter; runtime bootstrap
ACK barrier before its static Core closure; explicit guarded installer entries
and approved native/Node child inventories; owned helper cleanup and actual
Linux image/rules/negative-egress validation; and the candidate driver wiring.
Host Playwright contexts separately need exact owned HTTP/WS request guards
before any page, with service workers blocked. Those browser guards are request
restrictions and must not be reported as OS network confinement. Candidate
Docker execution remains unverified until the final fixed-source Linux gate
passes with these mechanisms connected.
