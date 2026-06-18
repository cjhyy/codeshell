/**
 * The injected transport. A `CdpSender` sends ONE CDP command and resolves its
 * result (throws on protocol error). This is the package's only contact with
 * the outside world — whoever instantiates the driver supplies it:
 *   - Electron: webContents.debugger.sendCommand(method, params)
 *   - Node/Bun standalone: a raw WebSocket client to a CDP endpoint
 *
 * `sessionId` is reserved for multi-target (multi-tab via the CDP Target domain)
 * — the Electron webview line never passes it (one debugger == one target); a
 * future standalone-browser line can route per-tab without changing this shape.
 */
export type CdpSender = (
  method: string,
  params?: Record<string, unknown>,
  sessionId?: string,
) => Promise<any>;

/** What the driver needs to know about the current page, supplied by the host
 *  (the host knows the target's URL/title; the driver stays UI/runtime-agnostic). */
export interface PageInfo {
  url: string;
  title?: string;
}
