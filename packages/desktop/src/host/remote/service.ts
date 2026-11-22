import { PrivateHostPeer, electronPrivatePort } from "../native-peer.js";
import { HostedRelay } from "./relay.js";

import { HostedAccountDevices } from "./account-devices.js";
import { HostedCloudProjects } from "./cloud-projects.js";
import { HostedCloudAccount } from "./cloud-account.js";
export function bindRemoteServices(port: Electron.MessagePortMain, cloudGrantFile: string) {
  const account = new HostedCloudAccount(() => peer, cloudGrantFile);
  const devices = new HostedAccountDevices(() => peer, account.manager);
  const projects = new HostedCloudProjects(() => peer, account);
  const relay = new HostedRelay(() => peer);
  const peer: PrivateHostPeer = new PrivateHostPeer(
    electronPrivatePort(port),
    (method, input, signal) => {
      if (method === "cloud/account") return account.run(input, signal);
      if (method.startsWith("devices/")) return devices.run(method, input, signal);
      if (method.startsWith("projects/")) return projects.run(method, input, signal);
      return relay.run(method, input);
    },
    () => {
      devices.close();
      account.close();
      void Promise.allSettled([relay.close(), projects.close()]);
    },
  );
  return {
    async close() {
      devices.close();
      try {
        await Promise.allSettled([projects.close(), relay.close()]);
      } finally {
        peer.close();
      }
    },
  };
}
