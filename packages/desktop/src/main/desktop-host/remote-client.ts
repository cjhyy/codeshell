import { PrivateHostPeer, electronPrivatePort } from "../../host/native-peer.js";
import { NativeRelayConnector } from "./relay-client.js";

import { NativeCloudAccount } from "./cloud-client.js";
import type { CloudEffects } from "./cloud-effects.js";

import { NativeCloudProjects } from "./cloud-projects-client.js";
export class NativeRemoteClient {
  private projects?: NativeCloudProjects;
  createProjects(deps: ConstructorParameters<typeof NativeCloudProjects>[1]) {
    if (this.projects) throw Error("Cloud projects already initialized");
    return (this.projects = new NativeCloudProjects(() => this.current(), deps));
  }
  private account?: NativeCloudAccount;
  createAccount(effects: CloudEffects) {
    if (this.account) throw Error("Cloud account already initialized");
    this.account = new NativeCloudAccount(() => this.current(), effects);
    if (this.peer) void this.account.connect().catch(() => {});
    return this.account;
  }
  private peer?: PrivateHostPeer;
  readonly relay = new NativeRelayConnector(() => this.current());
  lostRelay?: () => void;
  private current() {
    if (!this.peer) throw Error("Desktop Host unavailable");
    return this.peer;
  }
  bind(port: Electron.MessagePortMain) {
    this.disconnect();
    const peer: PrivateHostPeer = new PrivateHostPeer(
      electronPrivatePort(port),
      (method, input, signal) => {
        if (method.startsWith("relay/")) return this.relay.handle(method, input, signal);
        if (method.startsWith("projects/") && this.projects)
          return this.projects.handle(method, input, signal);
        if (!this.account) throw Error("Cloud account unavailable");
        return this.account.handle(method, input, signal);
      },
      () => {
        if (this.peer === peer) {
          this.peer = undefined;
          this.account?.disconnect();
          void this.projects?.disconnect().catch(() => {});
          if (this.relay.disconnect()) this.lostRelay?.();
        }
      },
    );
    this.peer = peer;
    void this.account?.connect().catch(() => {});
  }
  disconnect() {
    this.peer?.close();
  }
}
