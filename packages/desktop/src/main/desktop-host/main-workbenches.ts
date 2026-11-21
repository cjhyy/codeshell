import type { IpcMainEvent, MessageChannelMain, WebContents, WebFrameMain } from "electron";
import {
  DesktopHostIpc,
  type DesktopHostControl,
  type DesktopHostIdentity,
} from "../../shared/desktop-host-protocol.js";

export type HostStatus = "reconnecting" | "unavailable";
type Sender = Pick<IpcMainEvent, "sender" | "senderFrame">;
type PostControl = (message: DesktopHostControl, ports?: MessageChannelMain["port1"][]) => boolean;
interface Workbench {
  contents: WebContents;
  generation: number;
  committed: boolean;
  requestedFrame?: WebFrameMain;
  suspendedFrame?: WebFrameMain;
  bound?: DesktopHostIdentity;
}

/** Only createWindow() enrolls a WebContents. Other app windows may share its preload and URL. */
export class HostWorkbenchPorts {
  private readonly windows = new Map<WebContents, Workbench>();
  private status: HostStatus | "starting" | "ready" = "starting";

  constructor(
    private readonly assertSender: (sender: Sender) => void,
    private readonly createChannel: () => MessageChannelMain,
    private readonly post: PostControl,
  ) {}

  track(contents: WebContents): void {
    if (this.windows.has(contents)) return;
    const window: Workbench = { contents, generation: 1, committed: false };
    this.windows.set(contents, window);
    const invalidate = () => {
      window.generation++;
      window.requestedFrame = undefined;
      window.committed = false;
      if (window.bound) {
        const identity = window.bound;
        window.bound = undefined;
        this.post({ type: "revoke", identity });
      }
    };
    contents.on("did-start-navigation", (event) => {
      if (!event.isMainFrame || event.isSameDocument) return;
      window.suspendedFrame ??= window.requestedFrame;
      invalidate();
    });
    contents.on("did-navigate", () => {
      window.suspendedFrame = undefined;
      window.committed = true;
      this.offer(window);
    });
    contents.on("did-stop-loading", () => {
      // A cancelled navigation can leave the same document alive, without running preload again.
      const frame = window.suspendedFrame;
      window.suspendedFrame = undefined;
      if (!window.committed && frame && this.isCurrent(contents, frame)) {
        window.requestedFrame = frame;
        window.committed = true;
        this.offer(window);
      }
    });
    contents.on("render-process-gone", () => {
      window.suspendedFrame = undefined;
      invalidate();
    });
    contents.once("destroyed", () => {
      this.windows.delete(contents);
      invalidate();
    });
  }

  tracks(contents: WebContents): boolean {
    return this.windows.has(contents);
  }

  assertIdentity(identity: DesktopHostIdentity): void {
    for (const window of this.windows.values()) {
      if (window.contents.id !== identity.webContentsId || !window.requestedFrame) continue;
      const live = this.identity({ sender: window.contents, senderFrame: window.requestedFrame });
      if (
        live.frameToken === identity.frameToken &&
        live.frameGeneration === identity.frameGeneration
      )
        return;
    }
    throw new Error("Workbench document was revoked");
  }

  identity(event: Sender): DesktopHostIdentity {
    const window = this.windows.get(event.sender);
    if (
      !window?.committed ||
      !window.bound ||
      !event.senderFrame ||
      window.requestedFrame !== event.senderFrame ||
      !this.isCurrent(event.sender, event.senderFrame)
    )
      throw new Error("Task action requires the current workbench document");
    return window.bound;
  }

  connect(event: Sender): void {
    const window = this.windows.get(event.sender);
    if (!window || !event.senderFrame || !this.isCurrent(event.sender, event.senderFrame)) return;
    window.requestedFrame = event.senderFrame;
    this.offer(window);
  }

  setStatus(status: HostStatus | "ready"): void {
    this.status = status;
    for (const window of this.windows.values()) {
      if (status !== "ready") window.bound = undefined;
      this.offer(window);
    }
  }

  private isCurrent(contents: WebContents, frame: WebFrameMain): boolean {
    try {
      if (contents.isDestroyed() || frame.detached || contents.mainFrame !== frame) return false;
      this.assertSender({ sender: contents, senderFrame: frame });
      return true;
    } catch {
      return false;
    }
  }

  private offer(window: Workbench): void {
    const frame = window.requestedFrame;
    // A first connection waits for the initial Host. A reconnecting notification
    // would reject the renderer's startup reads before it receives its first port.
    if (
      this.status === "starting" ||
      !window.committed ||
      !frame ||
      !this.isCurrent(window.contents, frame)
    )
      return;
    if (this.status !== "ready") {
      try {
        frame.send(DesktopHostIpc.status, this.status);
      } catch {
        // A frame may detach between validation and IPC delivery.
      }
      return;
    }
    if (window.bound) return;
    const identity: DesktopHostIdentity = {
      webContentsId: window.contents.id,
      frameToken: frame.frameToken,
      frameGeneration: window.generation,
      windowKind: "workbench",
    };
    const channel = this.createChannel();
    if (!this.post({ type: "bind", identity }, [channel.port1])) {
      channel.port1.close();
      channel.port2.close();
      return;
    }
    try {
      frame.postMessage(DesktopHostIpc.port, null, [channel.port2]);
      window.bound = identity;
    } catch {
      channel.port2.close();
      this.post({ type: "revoke", identity });
    }
  }
}
