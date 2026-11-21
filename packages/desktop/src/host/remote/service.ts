import { PrivateHostPeer, electronPrivatePort } from "../native-peer.js";
import { HostedRelay } from "./relay.js";

import { HostedCloudAccount } from "./cloud-account.js";
export function bindRemoteServices(port: Electron.MessagePortMain, cloudGrantFile: string) {
  const account = new HostedCloudAccount(() => peer, cloudGrantFile);
  const relay = new HostedRelay(() => peer);
  const peer: PrivateHostPeer = new PrivateHostPeer(
    electronPrivatePort(port),
    (method, input, signal) =>
      method === "cloud/account" ? account.run(input, signal) : relay.run(method, input),
    () => {
      account.close();
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
