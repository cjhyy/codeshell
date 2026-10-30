# Outbound computer relay transport

The `@cjhyy/code-shell-server/remote-relay` entry implements device relay protocol
v1 and the outbound computer connector. A trusted, TLS-terminating service gives
each enrolled computer its own stable HTTPS origin. Local projects and tools
remain on that computer. This transport does not grant directory users access
to a computer, migrate projects, or replace phone pairing and Host authorization.
The relay can read requests and credentials: this is not end-to-end encryption.

The companion service must implement enrollment, host-only origins, credential
epochs, connection generations, single-use data tickets, proxy validation and
revocation. Those belong to the independent services repository. Consumers must
check the new public export and protocol capability explicitly; an older server
package with the same existing mobile interface does not provide this connector.

## Host lifecycle

```ts
import {
  AccessPasscode,
  RemoteHostManager,
  TrustedDeviceStore,
} from "@cjhyy/code-shell-server/mobile-remote";
import { createDeviceRelayConnector } from "@cjhyy/code-shell-server/remote-relay";

// Private paths and enrollment are supplied by the embedding application.
const passcode = new AccessPasscode({ filePath: privatePasscodePath });
// Configure the passcode in the local application's existing settings flow.
if (!passcode.isSet()) throw new Error("Configure the computer access passcode first");
const host = new RemoteHostManager({
  devices: new TrustedDeviceStore(privateDevicePath),
  onClientEvent: dispatchAuthorizedPhoneEvent,
  mobileRootDir: builtMobilePath,
  webApi: authorizedDesktopWebApi,
});
await host.start({ host: "127.0.0.1", port: 0, mode: "relay", passcode });
const connector = createDeviceRelayConnector({
  relayOrigin: enrollment.directoryOrigin,
  hostId: enrollment.hostId,
  publicOrigin: enrollment.publicOrigin,
  credential: enrollment.computerCredential,
  localHost: host.relayTarget(),
  onState: updateConnectionState,
});
connector.start();
// The ready state means welcome was checked and the fixed public origin set.
// A private deployment may supply `ca`; disabling TLS verification is not exposed.

// Explicit shutdown waits for all control, data and local TCP sockets to close.
await connector.close();
await host.stop();
```

`relayTarget()` is only available on a running relay-mode Host. Its fixed port,
AbortSignal and origin setter belong to that one Host startup. `host.stop()`
synchronously revokes the target and destroys the connector's sockets before
releasing the listener. A connector cannot restart with a revoked target, and a
late welcome cannot modify another Host generation. A port reused by another
local service does not inherit the old relay authority. Await `connector.close()`
when independently stopping/restarting the connector; do not call `start()` while
its asynchronous close is still settling.

Relay mode always listens on `127.0.0.1`, requires an initialized `AccessPasscode`,
and serves built mobile files even if a development proxy is configured. Before
welcome, it refuses to issue pairing URLs. The stable HTTPS origin is used for
pairing and the Desktop Web facade's existing same-origin checks. WebSocket
upgrades require both the exact external `Host` and `Origin`; native test clients
must supply these as a browser would. The HTTP/WS passcode gate, independent phone
secrets, pairing, per-socket viewer identities and device revocation remain in
force. Existing LAN and tunnel modes keep their existing behavior.

## Wire and resource limits

A control WSS connects to `/api/v1/remote-hosts/connect` using the computer bearer
credential in its Authorization header. It accepts only bounded JSON v1 welcome
and open messages; welcome must exactly match the enrolled host ID and origin.
It returns ready/failed messages. Handshake/welcome and each stream setup have a
10-second bound; native ping/pong runs every 20 seconds with a 60-second liveness
bound. Reconnect uses exponential backoff with jitter, capped at 30 seconds before
jitter. A TLS-verified control handshake returning 401 or 403 emits terminal
`unauthorized` and stops reconnecting; network errors and 5xx remain retryable.
It reconnects transport only and never queues or replays HTTP/actions.

Every open creates one fixed loopback TCP connection and one outbound data WSS at
`/api/v1/remote-hosts/streams/<streamId>`. Bearer credential, lease and one-time
ticket are headers, never query parameters. Credentials are not forwarded across
redirects. The connector caps simultaneous streams at 32. Closing/replacing a
control connection destroys all of its pending and attached data connections.

`createRelayByteStream(ws)` wraps one already authenticated, OPEN data WebSocket
as a Node Duplex. Callers must construct the WebSocket with
`maxPayload: RELAY_DATA_MAX_BYTES` (64 KiB) and `perMessageDeflate: false` so the
parser rejects oversized messages before allocating their entire payload.
Messages must be binary; outgoing chunks are at most 32 KiB. Node/ws stream
backpressure bounds queued transport data per stream; the connector does not
maintain an additional request queue or implement a credit protocol. A caller
must also honor Node's writable backpressure instead of buffering entire bodies.

The stream represents a whole TCP connection. An HTTP `request.end()` marks the
HTTP message body, not stream EOF. Use Node's HTTP parser/client with a dedicated,
non-reusing Agent and `Connection: keep-alive` toward the Host. This lets a Host
reject an unread upload while its response is still being parsed. Stop forwarding
the browser body on final response headers, then destroy this one-request stream
after the response completes; browser responses still use `Connection: close`.
Do not end the Duplex after merely sending a request. There is no custom
half-close protocol. Normal completion drains queued final bytes; cancellation
and revocation destroy the connection immediately. An abnormal local close may
flush already-read response bytes for at most two seconds; HTTP framing still
rejects truncated responses. If the Host forcibly closes before any response is
read, report a network failure. Never fabricate a response or replay the request.

## Verification scope

`bun test packages/server/src/remote-relay/relay.native.test.ts` starts a real Node
process with a locally trusted TLS certificate, real control/data WSS and the
actual RemoteHostManager. It exercises passcode and Origin rejection, independent
paired phones, phone revocation, uploads, built mobile serving, control reconnect,
Host stop with port reuse, stale welcome, early upload rejection, truncated
responses, large responses, Range bytes, slow consumers, concurrent cancellation,
binary/size limits, stream concurrency and a lost POST
response without replay. Existing remote Host tests cover LAN/tunnel compatibility.
The fixture relay is a protocol peer; it does not establish that the companion
service's enrollment, directory or full proxy has passed its own acceptance.

## Desktop settings

Desktop password/GitHub login and the ready main window's explicit saved-session
resume now enable device collaboration automatically when the same Account origin
advertises `relay: { enabled: true, directoryOrigin, protocolVersion: 1,
accountHandoffVersion: 1 }`. Discovery rejects another origin or unsupported
versions before sending a bearer. Missing capabilities do not roll back account
login or disable local projects. Construction and read-only status remain local;
a website account login never registers an execution computer.

The main process keeps `environmentIdentity(desktopDataDir)` stable and uses
`POST /api/v1/remote-hosts/ensure` for initial registration. An encrypted saved
device grant is reused for normal restart, reconnect and token refresh. Explicit
legacy ticket/account enrollment still rotates credentials and remains available
under Settings → Mobile Remote. `ensure` never silently replaces a live grant
when the first response is ambiguous. A lost initial response requires recovery;
normal logout/relogin can restore the same host once old grants are invalid.

Only main holds account/device/Host credentials. `cloud-account/session.enc` and
`mobile-remote/relay.enc` use OS safeStorage with owner-only permissions;
unencrypted Linux basic_text is rejected. Renderer IPC contains public identity,
connection IDs, bounded image attachments, events and task text only. Tokens are
absent from URLs, localStorage, prompts and status events. Login does not weaken
ordinary tool approvals or OS permissions.

The main workflow's **执行电脑 / 设备** entry lists the actual account computers,
shows local connecting/online/offline/unauthorized/unavailable state, discovers
the selected Host's real projects and dispatches through the existing Mobile WS
session/worker path. Each selected host/environment/project gets its own captured
session, composer, image attachments, output and approvals. Switching views keeps
existing connections and task ownership; Stop addresses the original connection's
session. An offline/retired target refuses dispatch and never falls back to a local
worker. Unknown delivery is surfaced without automatic retries.

Account dispatch is a separate, bounded gate alongside existing LAN/passcode
access. Main sends its account bearer **and source device proof only to the exact
Account directory** to obtain a 30-second single-use handoff for one target
host/environment/current relay lease. It sends that handoff in an HTTP body to
the target Host. The Host redeems it using its own main-held device credential,
checks all target fields, and creates an in-memory trusted device plus random
Host access token expiring within ten minutes. Ephemeral credentials never enter
the ordinary trusted-device JSON file. A separate Relay access token continuously
binds proxy HTTP/WSS streams to the initiating account root, source device grant
and target lease; Relay strips it before forwarding. Known Account tokens remain
forbidden on computer origins. This trusts the configured Account/Relay service:
it can inspect proxied traffic, and is not end-to-end encryption.

Logout/account switch/source or target revocation/root expiry fences this
identity's connector and remote access. Target Host stop clears ephemeral grants;
server-side authorization expiry closes streams. Existing local tasks and unrelated
LAN access are not cancelled. A pre-existing LAN/tunnel listener is preserved and
reported as unavailable for automatic Relay activation until that transport is
stopped; no automatic transport replacement is performed.

`bun test packages/desktop/src/main/device-relay.native.test.ts` exercises native
Node TLS enrollment, encrypted persistence, actual Host/connector lifecycle,
401 revocation, request bounds, no redirects and cancellation during enrollment.
`bun run --cwd packages/desktop test:e2e:device-relay` exercises the built main,
preload and settings UI in an isolated profile with a real OS keychain and local
TLS/WSS. Build Desktop first; an unlocked keychain is required, with no plaintext
fallback in the acceptance. The directory in these two tests is a controlled
protocol peer; companion Services implementation and final candidate compatibility
are covered by the separate cross-repository acceptance.

Actual public deployment and physical-phone background/weak-network acceptance
remain separate. These local tests do not claim those checks have passed.
