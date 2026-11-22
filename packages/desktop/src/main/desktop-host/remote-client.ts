import { PrivateHostPeer, type PrivatePort } from "../../host/native-peer.js";
import { NativeMobile } from "./mobile-client.js";

import { NativeCloudAccount } from "./cloud-client.js";
import type { CloudEffects } from "./cloud-effects.js";

import { NativeCloudProjects } from "./cloud-projects-client.js";
import { NativeAccountDevices } from "./account-devices-client.js";
export class NativeRemoteClient {
  constructor(private readonly waitForHost?: (signal: AbortSignal) => Promise<void>) {}
  private devices?: NativeAccountDevices;
  createDevices(deps: ConstructorParameters<typeof NativeAccountDevices>[1]) {
    if (this.devices) throw Error("Account devices already initialized");
    return (this.devices = new NativeAccountDevices(() => this.current(), deps));
  }
  private projects?: NativeCloudProjects;
  createProjects(deps: ConstructorParameters<typeof NativeCloudProjects>[1]) {
    if (this.projects) throw Error("Cloud projects already initialized");
    return (this.projects = new NativeCloudProjects(() => this.current(), deps));
  }
  private account?: NativeCloudAccount;
  createAccount(effects: CloudEffects) {
    if (this.account) throw Error("Cloud account already initialized");
    this.account = new NativeCloudAccount(() => this.current(), effects, this.waitForHost);
    if (this.peer) void this.account.connect().catch(() => {});
    return this.account;
  }
  private peer?: PrivateHostPeer;
  private mobile?: NativeMobile;
  createMobile(deps: ConstructorParameters<typeof NativeMobile>[1]) {
    if (this.mobile) throw Error("Mobile service already initialized");
    this.mobile = new NativeMobile(() => this.current(), deps);
    if (this.peer) void this.mobile.connect().catch(() => {});
    return this.mobile;
  }
  private current() {
    if (!this.peer) throw Error("Desktop Host unavailable");
    return this.peer;
  }
  bind(port: PrivatePort) {
    this.disconnect();
    const peer: PrivateHostPeer = new PrivateHostPeer(
      port,
      (method, input, signal) => {
        if (method.startsWith("mobile/") && this.mobile)
          return this.mobile.handle(method, input, signal);
        if (method.startsWith("devices/") && this.devices)
          return this.devices.handle(method, input, signal);
        if (method.startsWith("projects/") && this.projects)
          return this.projects.handle(method, input, signal);
        if (!this.account) throw Error("Cloud account unavailable");
        return this.account.handle(method, input, signal);
      },
      () => {
        if (this.peer === peer) {
          this.peer = undefined;
          this.account?.disconnect();
          this.devices?.disconnect();
          void this.projects?.disconnect().catch(() => {});
          this.mobile?.disconnect();
        }
      },
      (method, input) => {
        if (method === "devices/event") this.devices?.notice(input);
        if (method === "mobile/status")
          this.mobile?.changed(input as import("../../shared/device-relay.js").DesktopRelayStatus);
      },
    );
    this.peer = peer;
    void this.account?.connect().catch(() => {});
    void this.mobile?.connect().catch(() => {});
  }
  disconnect() {
    this.peer?.close();
  }
}
