import { PrivateHostPeer, electronPrivatePort } from "../../host/native-peer.js";
import { NativeRelayConnector } from "./relay-client.js";

export class NativeRemoteClient {
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
      (method, input, signal) => this.relay.handle(method, input, signal),
      () => {
        if (this.peer === peer) {
          this.peer = undefined;
          if (this.relay.disconnect()) this.lostRelay?.();
        }
      },
    );
    this.peer = peer;
  }
  disconnect() {
    this.peer?.close();
  }
}
