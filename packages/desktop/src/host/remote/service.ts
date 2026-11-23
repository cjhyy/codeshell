import { PrivateHostPeer, type PrivatePort } from "../native-peer.js";
import { HostedMobile } from "./mobile.js";
import { codeShellHome } from "@cjhyy/code-shell-core";
import { join } from "node:path";

import { HostedAccountDevices } from "./account-devices.js";
import { HostedCloudProjects } from "./cloud-projects.js";
import { HostedCloudAccount } from "./cloud-account.js";
import { hostedRooms, type RoomHostSources } from "../rooms/service.js";
export function bindRemoteServices(
  port: PrivatePort,
  userData: string,
  roomSources?: RoomHostSources,
) {
  let rooms: ReturnType<typeof hostedRooms> | undefined;
  const account = new HostedCloudAccount(
    () => peer,
    join(userData, "cloud-account", "session.enc"),
  );
  const mobile = new HostedMobile(
    () => peer,
    join(userData, "mobile-remote", "relay.enc"),
    join(codeShellHome(), "desktop"),
    account.manager,
  );
  const devices = new HostedAccountDevices(
    () => peer,
    account.manager,
    (identity, signal) => mobile.controller.accountRelaySource(identity, signal),
  );
  const projects = new HostedCloudProjects(() => peer, account);
  const peer: PrivateHostPeer = new PrivateHostPeer(
    port,
    (method, input, signal) => {
      if (method.startsWith("rooms/") && roomSources)
        return (rooms ??= hostedRooms(() => peer, userData, roomSources)).run(
          method,
          input,
          signal,
        );
      if (method === "cloud/account") return account.run(input, signal);
      if (method.startsWith("devices/")) return devices.run(method, input, signal);
      if (method.startsWith("projects/")) return projects.run(method, input, signal);
      return mobile.run(method, input, signal);
    },
    () => {
      closeRooms();
      devices.close();
      account.close();
      void Promise.allSettled([mobile.close(), projects.close()]);
    },
    (method, raw) => {
      if (method.startsWith("rooms/")) rooms?.notice(method, raw);
      if (method === "mobile/targetEnded") mobile.targetEnded((raw as { id?: string })?.id);
    },
  );
  function closeRooms() {
    const owner = rooms;
    rooms = undefined;
    owner?.close();
  }
  return {
    async close() {
      closeRooms();
      devices.close();
      try {
        await Promise.allSettled([projects.close(), mobile.close()]);
      } finally {
        peer.close();
      }
    },
  };
}
