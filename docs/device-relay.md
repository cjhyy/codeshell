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
jitter. It reconnects transport only and never queues or replays HTTP/actions.

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
HTTP message body, not stream EOF. Use Node's HTTP parser/client with
`Connection: close`; do not end the Duplex after merely sending a request. There
is no custom half-close protocol. Normal completion drains queued final bytes;
cancellation and revocation destroy the connection. The service must close a
response whose headers were already sent instead of replaying it after loss.

## Verification scope

`bun test packages/server/src/remote-relay/relay.native.test.ts` starts a real Node
process with a locally trusted TLS certificate, real control/data WSS and the
actual RemoteHostManager. It exercises passcode and Origin rejection, independent
paired phones, phone revocation, uploads, built mobile serving, control reconnect,
Host stop with port reuse, stale welcome, large responses, Range bytes, slow
consumers, cancellation, binary/size limits, stream concurrency and a lost POST
response without replay. Existing remote Host tests cover LAN/tunnel compatibility.
The fixture relay is a protocol peer; it does not establish that the companion
service's enrollment, directory or full proxy has passed its own acceptance.

Electron settings/enrollment integration, actual Desktop-to-service deployment,
and physical-phone background/weak-network acceptance are later work. These tests
do not claim those product flows are delivered.
