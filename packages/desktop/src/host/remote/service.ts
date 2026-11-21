import { PrivateHostPeer, electronPrivatePort } from "../native-peer.js";
import { HostedRelay } from "./relay.js";

export function bindRemoteServices(port: Electron.MessagePortMain) {
  const relay = new HostedRelay(() => peer);
  const peer: PrivateHostPeer = new PrivateHostPeer(
    electronPrivatePort(port),
    (method, input) => relay.run(method, input),
    () => {
      void relay.close().catch(() => {});
    },
  );
  return {
    async close() {
      peer.close();
      await relay.close();
    },
  };
}
