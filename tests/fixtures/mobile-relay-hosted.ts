import { MessageChannel, Worker, workerData } from "node:worker_threads";
import { join } from "node:path";
import type { RelaySecretCipher } from "@cjhyy/code-shell-core/internal/storage";
import {
  CloudAccountManager,
  createCloudAccountTransport,
  type SavedCloudAccount,
} from "@cjhyy/code-shell-server/account";
import { HostedMobile } from "../../packages/desktop/src/host/remote/mobile.js";
import { PrivateHostPeer, nodePrivatePort } from "../../packages/desktop/src/host/native-peer.js";
import { NativeMobile } from "../../packages/desktop/src/main/desktop-host/mobile-client.js";
import { relayGrantCustody } from "../../packages/desktop/src/main/device-relay-store.js";
import type { NativeGatewayResources } from "../../packages/desktop/src/main/mobile-gateway.js";
import type { DesktopRelayStatus } from "../../packages/desktop/src/shared/device-relay.js";
if (workerData?.kind === "mobile-relay-fixture") {
  const { port, file, environment } = workerData;
  const grant: SavedCloudAccount | undefined = workerData.account;
  const forbidden = () => {
    throw Error("unexpected account operation");
  };
  const request = createCloudAccountTransport();
  const account = new CloudAccountManager({
    store: { load: () => grant, save: forbidden, forget: forbidden, preflight: forbidden },
    changed: () => {},
    openExternal: forbidden,
    request: (input) => {
      if (input.origin !== grant?.origin) return forbidden();
      return request(input);
    },
  });
  const service = new HostedMobile(() => peer, file, environment, account);
  const peer: PrivateHostPeer = new PrivateHostPeer(
    nodePrivatePort(port),
    (method, input, signal) => service.run(method, input, signal),
    () => {},
    (method, v) => {
      if (method === "mobile/targetEnded") service.targetEnded((v as { id: string }).id);
    },
  );
}
export async function startHostedMobile(
  root: string,
  file: string,
  cipher: RelaySecretCipher,
  deps: NativeGatewayResources & {
    changed(status: DesktopRelayStatus): void;
    beforeSeal?(): Promise<void>;
  },
  account?: SavedCloudAccount,
) {
  const { port1, port2 } = new MessageChannel();
  const worker = new Worker(new URL(import.meta.url), {
    workerData: {
      kind: "mobile-relay-fixture",
      port: port2,
      file,
      account,
      environment: join(root, "environment"),
    },
    transferList: [port2],
  });
  const native = new NativeMobile(() => peer, {
    ...deps,
    account: {
      status: () =>
        account
          ? { state: "signed-in", origin: account.origin, account: account.account }
          : { state: "signed-out" },
    },
    custody: relayGrantCustody(file, {
      available: async () => cipher.available(),
      encrypt: async (s) => {
        if (s.startsWith("{")) await deps.beforeSeal?.();
        return cipher.encrypt(s);
      },
      decrypt: async (b) => cipher.decrypt(b),
    }),
  });
  const peer: PrivateHostPeer = new PrivateHostPeer(
    nodePrivatePort(port1),
    (method, input, signal) => native.handle(method, input, signal),
    () => native.disconnect(),
    (method, v) => {
      if (method === "mobile/status") native.changed(v as DesktopRelayStatus);
    },
  );
  await native.connect();
  return {
    controller: native,
    terminate: async () => {
      peer.close();
      await worker.terminate();
    },
  };
}
