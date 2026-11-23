import type {
  AccessPasscode,
  AccountRelayAccessProvider,
  CloudflaredBinary,
  RemoteHostManager,
  TunnelManager,
} from "@cjhyy/code-shell-server/mobile-remote";
import type { RelayLocalTarget } from "@cjhyy/code-shell-server/remote-relay";
import type { MobileRemoteGatewayStatus } from "./im-gateway-control-server.js";

export type MobileMode = "lan" | "tunnel" | "relay";
export type MobilePair = ReturnType<RemoteHostManager["createPairingUrl"]>;
export interface MobileGateway {
  status(): MobileRemoteGatewayStatus;
  start(
    mode: MobileMode,
    access: AccountRelayAccessProvider | undefined,
    signal: AbortSignal,
    publicOrigin?: string,
  ): Promise<void>;
  close(): Promise<void>;
  withdraw(): void;
  relayTarget(): RelayLocalTarget;
  pair(): MobilePair | Promise<MobilePair>;
}
export type NativeGatewayResources = {
  host: RemoteHostManager;
  tunnel: TunnelManager;
  binary: CloudflaredBinary;
  passcode: AccessPasscode;
};

/** Only this adapter operates the Desktop's running HTTP listener, passcode and tunnel binary. */
export function localMobileGateway(deps: NativeGatewayResources): MobileGateway {
  return {
    status() {
      const status = deps.host.status();
      return {
        running: !!status,
        mode: status?.mode,
        url:
          status?.mode === "tunnel"
            ? deps.tunnel.isConnected()
              ? deps.tunnel.publicUrl()
              : undefined
            : status?.url,
        tunnelRunning: deps.tunnel.isRunning(),
        tunnelConnected: deps.tunnel.isConnected(),
        passcodeSet: deps.passcode.isSet(),
        onlineDeviceCount: deps.host.onlineDeviceIds().length,
      };
    },
    async start(mode, access, signal) {
      signal.throwIfAborted();
      if (mode !== "lan" && !(mode === "relay" && access?.accountId) && !deps.passcode.isSet())
        throw Error("请先设置访问口令，再开启公网连接。");
      if (mode === "tunnel") {
        await deps.binary.ensureBinary();
        signal.throwIfAborted();
      }
      if (mode === "relay") deps.host.setAccountRelayAccess?.(access);
      await deps.host.start(
        mode === "lan"
          ? { host: "lan", port: 0 }
          : { mode, host: "127.0.0.1", port: 0, passcode: deps.passcode },
      );
      signal.throwIfAborted();
      if (mode === "tunnel") {
        const started = await deps.tunnel.start(deps.host.status()!.port);
        signal.throwIfAborted();
        deps.host.setPublicBaseUrl(started.url);
      }
    },
    async close() {
      await Promise.all([deps.tunnel.stop(), deps.host.stop()]);
    },
    withdraw: () => deps.host.setAccountRelayAccess?.(undefined),
    relayTarget: () => deps.host.relayTarget(),
    pair: () => deps.host.createPairingUrl(),
  };
}
