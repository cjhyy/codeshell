import { PrivateHostPeer, electronPrivatePort } from "../native-peer.js";
import { HostedRelay } from "./relay.js";

import { HostedCloudProjects } from "./cloud-projects.js";
import { HostedCloudAccount } from "./cloud-account.js";
export function bindRemoteServices(port: Electron.MessagePortMain, cloudGrantFile: string) {
  const account = new HostedCloudAccount(() => peer, cloudGrantFile);
  const projects = new HostedCloudProjects(() => peer, account);
  const relay = new HostedRelay(() => peer);
  const peer: PrivateHostPeer = new PrivateHostPeer(
    electronPrivatePort(port),
    (method, input, signal) => {
      if (method === "cloud/account") return account.run(input, signal);
      if (method.startsWith("projects/")) return projects.run(method, input, signal);
      return relay.run(method, input);
    },
    () => {
      account.close();
      void Promise.allSettled([relay.close(), projects.close()]);
    },
  );
  return {
    async close() {
      try {
        await Promise.allSettled([projects.close(), relay.close()]);
      } finally {
        peer.close();
      }
    },
  };
}
