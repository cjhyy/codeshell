import type {
  AccessPasscode,
  CloudflaredBinary,
  RemoteHostManager,
  TunnelManager,
} from "@cjhyy/code-shell-server/mobile-remote";
import {
  createDeviceRelayConnector,
  environmentIdentity,
  type DeviceRelayConnector,
} from "@cjhyy/code-shell-server/remote-relay";
import type {
  DesktopRelayEnrollment,
  DesktopRelayState,
  DesktopRelayStatus,
} from "../shared/device-relay.js";
import type {
  MobileRemoteGatewayStatus,
  MobileRemoteOpenResult,
} from "./im-gateway-control-server.js";
import { enrollRelayComputer, validateRelayEnrollment } from "./device-relay-enrollment.js";
import { DeviceRelayStore, type RelayRegistration } from "./device-relay-store.js";

/** One owner for all three transports. Stop fences pending starts/enrollment immediately. */
export class MobileRemoteController {
  private queue: Promise<unknown> = Promise.resolve();
  private generation = 0;
  private operation = new AbortController();
  private connector?: DeviceRelayConnector;
  private registration?: RelayRegistration;
  private loaded = false;
  private loadFailed = false;
  private state: DesktopRelayState = "unregistered";
  private disposed = false;
  constructor(
    private readonly deps: {
      host: RemoteHostManager;
      tunnel: TunnelManager;
      binary: CloudflaredBinary;
      passcode: AccessPasscode;
      store: DeviceRelayStore;
      environmentDir: string;
      changed: (status: DesktopRelayStatus) => void;
    },
  ) {}
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => {});
    return next;
  }
  private load() {
    if (this.loaded && !this.loadFailed) return;
    this.loaded = true;
    try {
      this.registration = this.deps.store.load();
      this.loadFailed = false;
      this.state = this.registration ? "stopped" : "unregistered";
    } catch {
      this.loadFailed = true;
      this.state = "storage-error";
    }
  }
  relayStatus(): DesktopRelayStatus {
    this.load();
    const data = this.registration;
    return {
      state: this.state,
      registered: !!data,
      ...(data
        ? {
            relayOrigin: data.relayOrigin,
            publicOrigin: data.publicOrigin,
            hostId: data.hostId,
            name: data.name,
          }
        : {}),
    };
  }
  private publish(state: DesktopRelayState) {
    this.state = state;
    try {
      this.deps.changed(this.relayStatus());
    } catch {
      // Renderer shutdown cannot retain transport or credential authority.
    }
  }
  private invalidate() {
    this.generation++;
    this.operation.abort();
    this.operation = new AbortController();
    // close() fences before awaiting its owned sockets; Host stop aborts its target too.
    void this.connector?.close().catch(() => {});
  }
  private async closeTransport() {
    const connector = this.connector;
    this.connector = undefined;
    await connector?.close();
    await Promise.all([this.deps.tunnel.stop(), this.deps.host.stop()]);
    if (this.registration && this.state !== "storage-error") this.publish("stopped");
  }
  enroll(input: DesktopRelayEnrollment, authorized: () => boolean): Promise<DesktopRelayStatus> {
    validateRelayEnrollment(input);
    this.invalidate();
    const generation = this.generation;
    const signal = this.operation.signal;
    return this.serial(async () => {
      if (this.disposed || generation !== this.generation || !authorized())
        throw new Error("登记已取消。");
      await this.closeTransport();
      this.load();
      this.deps.store.preflight();
      const environmentId = await environmentIdentity(this.deps.environmentDir);
      if (signal.aborted || !authorized()) throw new Error("登记已取消。");
      // Re-enrollment rotates the server credential. Forget the old value before
      // sending; an ambiguous response must never resurrect invalid authority.
      this.deps.store.forget();
      this.registration = undefined;
      this.publish("unregistered");
      try {
        const result = await enrollRelayComputer(input, environmentId, signal);
        if (signal.aborted || !authorized()) throw new Error("登记已取消。");
        this.deps.store.save(result);
        this.registration = result;
        this.publish("stopped");
        return this.relayStatus();
      } catch {
        throw new Error("登记未保存。请在目录页面生成新票据并重新登记；当前电脑连接已停止。");
      }
    });
  }
  forget(): Promise<void> {
    this.invalidate();
    return this.serial(async () => {
      await this.closeTransport();
      this.registration = undefined;
      this.loaded = true;
      this.loadFailed = false;
      try {
        this.deps.store.forget();
        this.publish("unregistered");
      } catch {
        this.publish("storage-error");
        throw new Error("无法移除本机登记，请检查文件权限后重试。");
      }
    });
  }
  start(opts?: { mode?: "lan" | "tunnel" | "relay" }): Promise<MobileRemoteOpenResult> {
    const mode = opts?.mode ?? "lan";
    if (!["lan", "tunnel", "relay"].includes(mode))
      return Promise.reject(new Error("无效的远程连接方式。"));
    const generation = this.generation;
    const signal = this.operation.signal;
    return this.serial(async () => {
      if (this.disposed || signal.aborted || generation !== this.generation)
        throw new Error("远程启动已取消。");
      this.load();
      const existing = this.status();
      if (existing.running && existing.mode === mode && existing.url) {
        return { url: existing.url, ...this.pairingUrl(), mode };
      }
      await this.closeTransport();
      if (signal.aborted) throw new Error("远程启动已取消。");
      try {
        if (mode !== "lan" && !this.deps.passcode.isSet())
          throw new Error("请先设置访问口令，再开启公网连接。");
        if (mode === "tunnel") {
          await this.deps.binary.ensureBinary();
          if (signal.aborted) throw new Error("远程启动已取消。");
        }
        if (mode === "relay" && !this.registration) throw new Error("请先登记这台电脑。");
        await this.deps.host.start(
          mode === "lan"
            ? { host: "lan", port: 0 }
            : {
                mode,
                host: "127.0.0.1",
                port: 0,
                passcode: this.deps.passcode,
              },
        );
        if (signal.aborted) throw new Error("远程启动已取消。");
        if (mode === "tunnel") {
          const started = await this.deps.tunnel.start(this.deps.host.status()!.port);
          if (signal.aborted) throw new Error("远程启动已取消。");
          this.deps.host.setPublicBaseUrl(started.url);
        } else if (mode === "relay") {
          await this.connectRelay(generation, signal);
        }
        return { url: this.status().url!, ...this.pairingUrl(), mode };
      } catch (error) {
        await this.closeTransport();
        throw error;
      }
    });
  }
  private connectRelay(generation: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve();
      };
      const abort = () => finish(new Error("远程启动已取消。"));
      const timer = setTimeout(
        () => finish(new Error("目录暂时不可用，请检查连接后重试。")),
        15_000,
      );
      signal.addEventListener("abort", abort, { once: true });
      this.connector = createDeviceRelayConnector({
        ...this.registration!,
        localHost: this.deps.host.relayTarget(),
        onState: (state) => {
          if (generation !== this.generation || state === "closed") return;
          this.publish(state);
          if (state === "ready") finish();
          if (state === "unauthorized") {
            this.registration = undefined;
            try {
              this.deps.store.forget();
            } catch {
              this.publish("storage-error");
            }
            this.publish(this.state === "storage-error" ? "storage-error" : "unauthorized");
            finish(new Error("电脑登记已被撤销或替换，请使用新票据重新登记。"));
            // Running connections have already resolved start: retire their Host
            // without queuing behind that earlier start promise.
            void this.stop().catch(() => this.publish("disconnected"));
          }
        },
      });
      this.connector.start();
    });
  }
  stop(): Promise<void> {
    this.invalidate();
    return this.serial(async () => {
      await this.closeTransport();
      this.load();
      this.publish(this.registration ? "stopped" : this.state);
    });
  }
  dispose(): Promise<void> {
    this.disposed = true;
    return this.stop();
  }
  pairingUrl(): { pairingUrl: string; expiresAt: number } {
    if (!this.status().url) throw new Error("远程连接尚未就绪。");
    const pairing = this.deps.host.createPairingUrl();
    return { pairingUrl: pairing.url, expiresAt: pairing.expiresAt };
  }
  status(): MobileRemoteGatewayStatus {
    const status = this.deps.host.status();
    return {
      running: !!status,
      mode: status?.mode,
      url:
        status?.mode === "relay"
          ? this.state === "ready"
            ? this.registration?.publicOrigin
            : undefined
          : status?.mode === "tunnel"
            ? this.deps.tunnel.isConnected()
              ? this.deps.tunnel.publicUrl()
              : undefined
            : status?.url,
      tunnelRunning: this.deps.tunnel.isRunning(),
      tunnelConnected: this.deps.tunnel.isConnected(),
      passcodeSet: this.deps.passcode.isSet(),
      onlineDeviceCount: this.deps.host.onlineDeviceIds().length,
    };
  }
}
