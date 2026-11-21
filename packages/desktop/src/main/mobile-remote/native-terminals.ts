import { randomUUID } from "node:crypto";
import type { RemoteTerminalDeps, RemoteTerminalEvent } from "./remote-terminals.js";
import type { TerminalControl, TerminalDelivery } from "./terminal-port.js";

/** Only Main knows which socket is authenticated. A new port, policy change or
 * socket disconnect invalidates outstanding remote output. Input is never retried. */
export class NativeRemoteTerminals {
  private port?: Electron.MessagePortMain;
  private revision = 0;
  private readonly viewers = new Map<string, { deviceId: string; generation: string }>();
  constructor(private readonly deps: Pick<RemoteTerminalDeps, "remote" | "policy">) {}
  get enabled() {
    return this.deps.policy.enabled;
  }
  bind(port: Electron.MessagePortMain) {
    this.disconnect();
    this.port = port;
    port.on("message", ({ data, ports }) => {
      for (const extra of ports) extra.close();
      if (ports.length || this.port !== port) return;
      const notice = data as TerminalDelivery;
      if (notice.revision !== this.revision || !notice.event?.type.startsWith("terminal.")) return;
      if (notice.kind === "list") {
        if (notice.event.type === "terminal.list.ok" && notice.event.enabled === this.enabled)
          this.deps.remote.broadcast(notice.event);
      } else if (notice.kind === "reply" && this.enabled) {
        const viewer = this.viewers.get(notice.viewerId);
        if (
          viewer?.generation === notice.generation &&
          this.deps.remote.hasAuthenticatedViewer(notice.viewerId, viewer.deviceId)
        )
          this.deps.remote.sendToViewer(notice.viewerId, notice.event);
      }
    });
    port.on("close", () => {
      if (this.port === port) this.disconnect();
    });
    port.start();
    this.send({ kind: "policy", enabled: this.enabled, revision: ++this.revision });
  }
  disconnect() {
    const port = this.port;
    this.port = undefined;
    this.viewers.clear();
    port?.close();
  }
  private send(frame: TerminalControl) {
    this.port?.postMessage(frame);
  }
  setEnabled(enabled: boolean) {
    this.deps.policy.set(enabled);
    if (!enabled) this.viewers.clear();
    this.send({ kind: "policy", enabled, revision: ++this.revision });
    if (!this.port)
      this.deps.remote.broadcast({ type: "terminal.list.ok", enabled, terminals: [] });
  }
  releaseViewer(viewerId: string) {
    if (this.viewers.delete(viewerId)) this.send({ kind: "release", viewerId });
  }
  handle(event: RemoteTerminalEvent) {
    const { viewerId, deviceId } = event;
    if (!viewerId || !deviceId || !this.deps.remote.hasAuthenticatedViewer(viewerId, deviceId))
      return;
    if (!this.enabled || !this.port) {
      this.deps.remote.sendToViewer(
        viewerId,
        event.type === "terminal.list"
          ? { type: "terminal.list.ok", enabled: this.enabled, terminals: [] }
          : {
              type: "terminal.error",
              code: this.enabled ? "failed" : "disabled",
              message: this.enabled ? "桌面终端暂时无法连接。" : "桌面端没有开启远程终端。",
              ...("requestId" in event && { requestId: event.requestId }),
              ...("terminalId" in event && { terminalId: event.terminalId }),
            },
      );
      return;
    }
    let viewer = this.viewers.get(viewerId);
    if (viewer?.deviceId !== deviceId) {
      if (viewer) this.releaseViewer(viewerId);
      viewer = { deviceId, generation: randomUUID() };
      this.viewers.set(viewerId, viewer);
    }
    this.send({ kind: "event", event, generation: viewer.generation });
  }
}
