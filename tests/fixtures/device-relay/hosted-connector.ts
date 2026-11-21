import { MessageChannel } from "node:worker_threads";
import {
  createDeviceRelayConnector as createConnector,
  type DeviceRelayConnectorOptions,
} from "../../../packages/server/src/remote-relay/connector.js";
import {
  PrivateHostPeer,
  nodePrivatePort,
} from "../../../packages/desktop/src/host/native-peer.js";
import { HostedRelay } from "../../../packages/desktop/src/host/remote/relay.js";
import { NativeRelayConnector } from "../../../packages/desktop/src/main/desktop-host/relay-client.js";

/** Exercise the production private-port protocol with only this fixture's TLS trust anchor. */
export function createDeviceRelayConnector(options: DeviceRelayConnectorOptions) {
  const { port1, port2 } = new MessageChannel();
  const hosted = new HostedRelay(
    () => server,
    (config) => createConnector({ ...config, ca: options.ca }),
  );
  const native = new NativeRelayConnector(() => client);
  const server: PrivateHostPeer = new PrivateHostPeer(nodePrivatePort(port1), (method, input) =>
    hosted.run(method, input),
  );
  const client: PrivateHostPeer = new PrivateHostPeer(
    nodePrivatePort(port2),
    (method, input, signal) => native.handle(method, input, signal),
  );
  port1.unref();
  port2.unref();
  options.localHost.signal.addEventListener(
    "abort",
    () => {
      client.close();
      server.close();
    },
    { once: true },
  );
  return native.create(options);
}
