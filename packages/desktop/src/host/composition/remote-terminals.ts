import { RemoteTerminals } from "../../main/mobile-remote/remote-terminals.js";
import type { TerminalControl, TerminalDelivery } from "../../main/mobile-remote/terminal-port.js";
import { getProjectStore } from "../../main/project-store.js";

/** The paired transport and Desktop workbench share this process's PTY registry. */
export function bindRemoteTerminals(port: Electron.MessagePortMain) {
  const viewers = new Map<string, { deviceId: string; generation: string }>();
  let enabled = false;
  let revision = 0;
  let open = true;
  const send = (delivery: TerminalDelivery) => {
    if (open) port.postMessage(delivery);
  };
  const terminals = new RemoteTerminals({
    policy: {
      get enabled() { return enabled; },
      set(value) {
        enabled = value;
      },
    },
    projectCwd: (id) => getProjectStore().resolveProjectRootByIdSync(id).cwd,
    remote: {
      sendToViewer(viewerId, event) {
        const viewer = viewers.get(viewerId);
        if (
          viewer &&
          (event.type === "terminal.data" ||
            event.type === "terminal.exit" ||
            event.type === "terminal.opened" ||
            event.type === "terminal.list.ok" ||
            event.type === "terminal.error")
        )
          send({ kind: "reply", revision, viewerId, generation: viewer.generation, event });
      },
      hasAuthenticatedViewer: (id, device) => viewers.get(id)?.deviceId === device,
      broadcast(event) {
        if (event.type === "terminal.list.ok") send({ kind: "list", revision, event });
      },
    },
  });
  function close() {
    if (!open) return;
    open = false;
    viewers.clear();
    terminals.setEnabled(false);
    port.close();
  }
  port.on("close", close);
  port.on("message", ({ data, ports }) => {
    for (const extra of ports) extra.close();
    if (!open || ports.length) return;
    const frame = data as TerminalControl;
    if (frame.kind === "policy" && frame.revision > revision) {
      revision = frame.revision;
      if (!frame.enabled) viewers.clear();
      terminals.setEnabled(frame.enabled);
    } else if (frame.kind === "release") {
      viewers.delete(frame.viewerId);
      terminals.releaseViewer(frame.viewerId);
    } else if (frame.kind === "event" && terminals.enabled) {
      const { viewerId, deviceId } = frame.event;
      if (!viewerId || !deviceId) return;
      const previous = viewers.get(viewerId);
      if (previous && previous.generation !== frame.generation) terminals.releaseViewer(viewerId);
      viewers.set(viewerId, { deviceId, generation: frame.generation });
      terminals.handle(frame.event);
    }
  });
  port.start();
  return close;
}
