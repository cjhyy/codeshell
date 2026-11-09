import { BrowserWindow, ipcMain, webContents } from "electron";
import { probeLocalhostPorts } from "./port-probe.js";

// Common dev-server ports (subset of Codex's list). Probed in main via real TCP
// connect (see port-probe.ts) instead of renderer no-cors fetch — no console
// noise, no opaque-response 403 false-reads. The renderer only renders the
// resulting open set.
export const CANDIDATE_DEV_PORTS = [
  3000, 3001, 4000, 5000, 5173, 5174, 6006, 7000, 8000, 8080, 8888, 9000, 1420, 1313,
];

export interface BrowserPopoutIpcDeps {
  mainWindows: Set<BrowserWindow>;
  popoutParents: Map<number, number>;
  browserAnchorsByParent: Map<number, unknown[]>;
}

/** Dev-server port probing and browser popout element-anchor forwarding. */
export function registerBrowserPopoutIpc(deps: BrowserPopoutIpcDeps) {
  const { mainWindows, popoutParents, browserAnchorsByParent } = deps;

  ipcMain.handle("browser:probePorts", async (_e, ports?: unknown) => {
    const candidates =
      Array.isArray(ports) &&
      ports.length <= 64 &&
      ports.every((p) => Number.isSafeInteger(p) && (p as number) >= 1 && (p as number) <= 65_535)
        ? (ports as number[])
        : CANDIDATE_DEV_PORTS;
    return probeLocalhostPorts(candidates);
  });

  // A popout pinned an element anchor → forward it to the parent window's
  // renderer, which dispatches the normal add-anchor flow into the composer.
  ipcMain.on("browser:anchor", (e, anchor: unknown) => {
    const parentId = popoutParents.get(e.sender.id);
    if (parentId === undefined) return;
    try {
      if (Buffer.byteLength(JSON.stringify(anchor)) > 256 * 1024) return;
    } catch {
      return;
    }
    const parent = BrowserWindow.fromId(parentId);
    if (parent && !parent.isDestroyed())
      parent.webContents.send("browser:anchor-from-popout", anchor);
  });

  // ── Browser-anchor hub(圈选统一架构,spec 2026-06-12)─────────────────────
  // The MAIN WINDOW owns anchor state (per session bucket); it pushes the active
  // bucket's browser anchors here on every change. We keep one snapshot per
  // parent and broadcast it only to that parent's popouts — and seed newly-opened popouts — so
  // all browser surfaces echo the same annotation set (and all clear together
  // when a message sends). Ops flow the other way: a popout's add/remove is
  // forwarded to its parent window, which mutates state; the loop closes via the
  // next sync. Full-state-down means a late-opened popout can never drift.
  function broadcastBrowserAnchors(parentId: number, snapshot: unknown[]): void {
    for (const [popoutWcId, candidateParentId] of popoutParents) {
      if (candidateParentId !== parentId) continue;
      const wc = webContents.fromId(popoutWcId);
      if (wc && !wc.isDestroyed()) wc.send("browser:anchors-state", snapshot);
    }
  }

  ipcMain.on("browser:anchors-sync", (event, anchors: unknown) => {
    const parent = BrowserWindow.fromWebContents(event.sender);
    if (!parent || !mainWindows.has(parent) || !Array.isArray(anchors) || anchors.length > 256)
      return;
    let snapshot: unknown[];
    try {
      const encoded = JSON.stringify(anchors);
      if (Buffer.byteLength(encoded) > 1024 * 1024) return;
      snapshot = JSON.parse(encoded) as unknown[];
    } catch {
      return;
    }
    browserAnchorsByParent.set(parent.id, snapshot);
    broadcastBrowserAnchors(parent.id, snapshot);
  });

  // A popout asked to remove an anchor → forward to the owner (parent window).
  ipcMain.on("browser:anchor-remove", (e, anchorId: unknown) => {
    const parentId = popoutParents.get(e.sender.id);
    if (parentId === undefined) return;
    if (
      typeof anchorId !== "string" ||
      !anchorId ||
      anchorId.length > 512 ||
      anchorId.includes("\0")
    ) {
      return;
    }
    const parent = BrowserWindow.fromId(parentId);
    if (parent && !parent.isDestroyed()) {
      parent.webContents.send("browser:anchor-remove-from-popout", anchorId);
    }
  });

  // A popout asked to update an anchor's comment → forward to the owner.
  ipcMain.on("browser:anchor-update", (e, update: unknown) => {
    const parentId = popoutParents.get(e.sender.id);
    if (parentId === undefined) return;
    try {
      if (
        !update ||
        typeof update !== "object" ||
        Buffer.byteLength(JSON.stringify(update)) > 64 * 1024
      ) {
        return;
      }
    } catch {
      return;
    }
    const parent = BrowserWindow.fromId(parentId);
    if (parent && !parent.isDestroyed()) {
      parent.webContents.send("browser:anchor-update-from-popout", update);
    }
  });
}
