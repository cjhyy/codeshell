/**
 * Browser-automation host (Electron main side). Ties the worker's browser_*
 * tool requests to the actual webview:
 *   worker tool → ctx.browser → AgentServer emits a __browser_action__ request
 *   → agent-bridge hands the action here → we drive the active webview guest
 *     via the browser-driver (withAttached + CdpBrowserDriver) → return JSON.
 *
 * Tracks the most-recently-attached browser-panel guest webContents as the
 * automation target (MVP: single active tab). Kept separate from agent-bridge
 * so the routing is unit-testable and the driver module stays UI-agnostic.
 */

import type { WebContents } from "electron";
import { CdpBrowserDriver } from "./cdp-driver.js";
import { attachDebugger, detachDebugger } from "./electron-cdp.js";
import { isDomainAllowed, isSensitiveAction, type BrowserAutomationPolicy } from "./policy.js";

/**
 * Per-guest driver cache. The CdpBrowserDriver holds the ref→backendNodeId map
 * from the latest snapshot, so click/type (separate worker calls) MUST reuse
 * the same driver instance that produced the snapshot — a fresh driver per
 * action would make every ref stale. Keyed by webContents.id; the debugger
 * stays attached across actions on the same guest and is detached when the
 * guest goes away (or via releaseGuest).
 */
const drivers = new Map<number, CdpBrowserDriver>();
const attachedGuests = new Map<number, WebContents>();

function driverForGuest(guest: WebContents): CdpBrowserDriver {
  const id = guest.id;
  let d = drivers.get(id);
  if (!d) {
    attachDebugger(guest);
    attachedGuests.set(id, guest);
    d = new CdpBrowserDriver(
      (method, params) => guest.debugger.sendCommand(method, params ?? {}),
      () => ({ url: safeUrl(guest) ?? "", title: safeTitle(guest) }),
    );
    drivers.set(id, d);
    // Auto-cleanup when the guest is destroyed.
    guest.once("destroyed", () => releaseGuest(id));
  }
  return d;
}

/** Detach + forget a guest's driver (on destroy, or when automation ends). */
export function releaseGuest(id: number): void {
  const guest = attachedGuests.get(id);
  if (guest && !guest.isDestroyed()) detachDebugger(guest);
  attachedGuests.delete(id);
  drivers.delete(id);
}

/** The action shape the worker sends (args of the __browser_action__ request). */
export interface BrowserActionRequest {
  action: "snapshot" | "click" | "type" | "navigate" | "scroll" | "readContent" | "waitForLoad" | "pressEnter";
  ref?: string;
  text?: string;
  url?: string;
  dir?: "up" | "down";
  amount?: number;
  timeoutMs?: number;
}

/** Resolve a target webContents and approve sensitive actions. Injected so
 *  tests don't need Electron / the real settings store. */
export interface AutomationDeps {
  /** Current automation-target guest webContents, or null if no panel/tab. */
  activeGuest: () => WebContents | null;
  /** Domain whitelist / policy (read from settings). */
  policy: () => BrowserAutomationPolicy;
  /** Ask the user to approve a sensitive/off-whitelist action. Resolves true to
   *  proceed. Undefined → no approver wired → sensitive actions are refused. */
  approve?: (summary: string) => Promise<boolean>;
}

/**
 * Handle one browser action. Returns the JSON-stringified result (the worker
 * parses it back into a BrowserResult / BrowserSnapshot). Never throws — every
 * failure becomes a safe {ok:false,detail} so the agent gets a usable message.
 */
export async function handleBrowserAction(
  req: BrowserActionRequest,
  deps: AutomationDeps,
): Promise<string> {
  const guest = deps.activeGuest();
  if (!guest || guest.isDestroyed()) {
    return JSON.stringify({ ok: false, detail: "no active browser panel/tab" });
  }

  const policy = deps.policy();

  // Domain whitelist (navigate target, or the current page for other actions).
  const targetUrl = req.action === "navigate" ? req.url : safeUrl(guest);
  if (targetUrl && !isDomainAllowed(targetUrl, policy)) {
    const ok = await requestApproval(deps, `访问域名 ${hostOf(targetUrl)}(不在白名单)`);
    if (!ok) return JSON.stringify({ ok: false, detail: `domain not allowed: ${hostOf(targetUrl)}` });
  }

  // Sensitive action approval (click/type on payment/delete/credential surfaces).
  if (isSensitiveAction(req)) {
    const ok = await requestApproval(deps, `敏感浏览器操作:${req.action} ${req.ref ?? ""}`);
    if (!ok) return JSON.stringify({ ok: false, detail: "sensitive action declined" });
  }

  // Reuse the per-guest driver so the snapshot's ref map survives into the
  // following click/type calls (each is a separate worker request).
  const driver = driverForGuest(guest);
  try {
    let result: unknown;
    switch (req.action) {
      case "snapshot":
        result = await driver.snapshot();
        break;
      case "click":
        result = await driver.click(req.ref ?? "");
        break;
      case "type":
        result = await driver.type(req.ref ?? "", req.text ?? "");
        break;
      case "navigate":
        result = await driver.navigate(req.url ?? "");
        break;
      case "scroll":
        result = await driver.scroll(req.dir ?? "down", req.amount);
        break;
      case "readContent":
        result = await driver.readContent();
        break;
      case "waitForLoad":
        result = await driver.waitForLoad(req.timeoutMs);
        break;
      case "pressEnter":
        result = await driver.pressEnter(req.ref);
        break;
      default:
        result = { ok: false, detail: `unknown action: ${(req as { action: string }).action}` };
    }
    return JSON.stringify(result);
  } catch (e) {
    return JSON.stringify({ ok: false, detail: e instanceof Error ? e.message : String(e) });
  }
}

function safeTitle(wc: WebContents): string | undefined {
  try {
    return wc.getTitle() || undefined;
  } catch {
    return undefined;
  }
}

async function requestApproval(deps: AutomationDeps, summary: string): Promise<boolean> {
  if (!deps.approve) return false; // no approver → refuse (fail-closed)
  try {
    return await deps.approve(summary);
  } catch {
    return false;
  }
}

function safeUrl(wc: WebContents): string | undefined {
  try {
    return wc.getURL() || undefined;
  } catch {
    return undefined;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
