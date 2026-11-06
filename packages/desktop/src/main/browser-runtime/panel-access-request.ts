/**
 * Agent-initiated request for the BrowserPanel tab the user is looking at.
 *
 * Before this, a model told "use the page in my panel" could only reopen its
 * own task window (and claim it was the panel) or tell the user to find the
 * shield button. Now it asks; the panel shows a confirmation bar, and only the
 * user's click there grants the tab — through the same renderer grant path as
 * the shield, so the model never holds a way to grant itself.
 *
 * A declined or unanswered request is remembered until the next run, so a
 * model cannot keep re-prompting the user within one request.
 */
import { randomUUID } from "node:crypto";
import type { IpcMain, WebContents } from "electron";
import { activeGuestForSession, guestRecordForId } from "../browser-driver/active-guest.js";
import { builtInTabClaimBackend, type BuiltInBrowserHandoffStatus } from "./built-in-handoff.js";

export const PANEL_ACCESS_REQUEST_CHANNEL = "browser:panel-access-request";
export const PANEL_ACCESS_RESPONSE_CHANNEL = "browser:panel-access-response";
const DEFAULT_TIMEOUT_MS = 60_000;

/** Payload the panel renders as its confirmation bar. */
export interface PanelAccessPrompt {
  requestId: string;
  sessionId: string;
  /** Main-owned identity of the exact tab being requested, not its URL. */
  guestId: number;
  url: string;
  title: string;
  expiresAt: number;
}

interface PanelTarget {
  windowId: number;
  guestId: number;
  url: string;
  title: string;
}

export interface PanelAccessRequestDeps {
  status: (sessionId: string) => BuiltInBrowserHandoffStatus;
  /** The window and page of the session's active panel tab, if one is mounted. */
  panelFor: (sessionId: string) => PanelTarget | null;
  /** Deliver the prompt to that window; false when it no longer exists. */
  show: (windowId: number, prompt: PanelAccessPrompt) => boolean | Promise<boolean>;
  now: () => number;
  timeoutMs: number;
}

interface Pending {
  sessionId: string;
  windowId: number;
  guestId: number;
  resolve: (granted: boolean) => void;
}

function result(ok: boolean, code: string, detail: string): string {
  return JSON.stringify({ ok, code, retryable: false, detail });
}

export class PanelAccessRequests {
  private readonly deps: PanelAccessRequestDeps;
  private readonly pending = new Map<string, Pending>();
  private readonly inFlight = new Map<string, Promise<string>>();
  private readonly declined = new Set<string>();

  constructor(deps: Partial<PanelAccessRequestDeps> = {}) {
    this.deps = {
      status: (sessionId) => builtInTabClaimBackend.status(sessionId),
      panelFor: defaultPanelFor,
      show: defaultShow,
      now: Date.now,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      ...deps,
    };
  }

  /** Ask the user; resolves to a BrowserResult JSON string. Concurrent asks share one prompt. */
  request(sessionId: string): Promise<string> {
    const existing = this.inFlight.get(sessionId);
    if (existing) return existing;
    const asking = this.ask(sessionId).finally(() => this.inFlight.delete(sessionId));
    this.inFlight.set(sessionId, asking);
    return asking;
  }

  /** The panel answered. Only the window the prompt was sent to may answer it. */
  respond(requestId: string, granted: boolean, senderWindowId: number | undefined): void {
    const pending = this.pending.get(requestId);
    if (!pending || pending.windowId !== senderWindowId) return;
    this.pending.delete(requestId);
    const status = granted ? this.deps.status(pending.sessionId) : undefined;
    pending.resolve(
      status?.granted === true &&
        status.sessionId === pending.sessionId &&
        status.guestId === pending.guestId,
    );
  }

  /** A new user request may ask again. */
  beginRun(sessionId: string): void {
    this.declined.delete(sessionId);
  }

  forgetSession(sessionId: string): void {
    this.declined.delete(sessionId);
    for (const [requestId, pending] of this.pending) {
      if (pending.sessionId !== sessionId) continue;
      this.pending.delete(requestId);
      pending.resolve(false);
    }
  }

  private async ask(sessionId: string): Promise<string> {
    const granted = (status: BuiltInBrowserHandoffStatus) =>
      result(
        true,
        "OK",
        `browser actions now drive the BrowserPanel tab "${status.title || "(untitled)"}" — ${status.url || "(blank)"}`,
      );
    const before = this.deps.status(sessionId);
    if (before.granted) return granted(before);
    if (this.declined.has(sessionId)) {
      return result(
        false,
        "NEEDS_HUMAN",
        "The user already declined or did not answer a panel access request for this request. " +
          "Do not ask again; continue without the panel or wait for the user's next message.",
      );
    }
    const panel = this.deps.panelFor(sessionId);
    if (!panel) {
      return result(
        false,
        "NEEDS_HUMAN",
        "No BrowserPanel tab is open for this task. Ask the user to open the page in the " +
          "browser panel first; do not open a task window in its place.",
      );
    }
    const requestId = randomUUID();
    const answer = new Promise<boolean>((resolve) => {
      this.pending.set(requestId, {
        sessionId,
        windowId: panel.windowId,
        guestId: panel.guestId,
        resolve,
      });
    });
    const shown = await this.deps.show(panel.windowId, {
      requestId,
      sessionId,
      guestId: panel.guestId,
      url: panel.url,
      title: panel.title,
      expiresAt: this.deps.now() + this.deps.timeoutMs,
    });
    if (!shown) this.respond(requestId, false, panel.windowId);
    const timer = setTimeout(
      () => this.respond(requestId, false, panel.windowId),
      this.deps.timeoutMs,
    );
    const answered = await answer;
    clearTimeout(timer);
    const after = this.deps.status(sessionId);
    if (
      answered &&
      after.granted &&
      after.sessionId === sessionId &&
      after.guestId === panel.guestId
    )
      return granted(after);
    this.declined.add(sessionId);
    return result(
      false,
      "NEEDS_HUMAN",
      "The user did not grant the BrowserPanel tab. Do not ask again for this request, and do " +
        "not substitute the task window while claiming to operate the panel.",
    );
  }
}

function defaultPanelFor(sessionId: string): PanelTarget | null {
  const target = activeGuestForSession(sessionId);
  if (!target) return null;
  const windowId = guestRecordForId(target.guestId)?.windowId;
  if (windowId === undefined) return null;
  const read = (fn: () => string) => {
    try {
      return fn();
    } catch {
      return "";
    }
  };
  return {
    windowId,
    guestId: target.guestId,
    url: read(() => target.guest.getURL()),
    title: read(() => target.guest.getTitle()),
  };
}

async function defaultShow(windowId: number, prompt: PanelAccessPrompt): Promise<boolean> {
  const { BrowserWindow } = await import("electron");
  const window = BrowserWindow.fromId(windowId);
  if (!window || window.isDestroyed()) return false;
  window.webContents.send(PANEL_ACCESS_REQUEST_CHANNEL, prompt);
  return true;
}

export const panelAccessRequests = new PanelAccessRequests();

/** Route the panel's Allow/Deny answer back to the waiting request. */
export function registerPanelAccessResponses(
  ipc: Pick<IpcMain, "on">,
  windowIdOf: (sender: WebContents) => number | undefined,
  requests: Pick<PanelAccessRequests, "respond"> = panelAccessRequests,
): void {
  ipc.on(PANEL_ACCESS_RESPONSE_CHANNEL, (event, payload: unknown) => {
    const { requestId, granted } = (payload ?? {}) as { requestId?: unknown; granted?: unknown };
    if (typeof requestId !== "string" || typeof granted !== "boolean") return;
    requests.respond(requestId, granted, windowIdOf(event.sender));
  });
}
