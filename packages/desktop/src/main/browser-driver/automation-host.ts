/**
 * Browser-automation host (Electron main side). Ties the worker's browser_*
 * tool requests to the actual webview:
 *   worker tool → ctx.browser → AgentServer emits a __browser_action__ request
 *   → agent-bridge hands the action here → we drive the active webview guest
 *     via the browser-driver (per-action attach + CdpBrowserDriver) → return JSON.
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
 * action would make every ref stale. Keyed by webContents.id; debugger
 * attachment is deliberately separate and only lasts for one action.
 */
const drivers = new Map<number, CdpBrowserDriver>();
const knownGuests = new Map<number, WebContents>();
const automationAttachedGuests = new Set<number>();

function driverForGuest(guest: WebContents): CdpBrowserDriver {
  const id = guest.id;
  let d = drivers.get(id);
  if (!d) {
    knownGuests.set(id, guest);
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
  const guest = knownGuests.get(id);
  if (guest && !guest.isDestroyed() && automationAttachedGuests.has(id)) detachDebugger(guest);
  automationAttachedGuests.delete(id);
  knownGuests.delete(id);
  drivers.delete(id);
}

/** The action shape the worker sends (args of the __browser_action__ request). */
export interface BrowserActionRequest {
  action:
    | "snapshot"
    | "click"
    | "type"
    | "navigate"
    | "scroll"
    | "readContent"
    | "extractLinks"
    | "waitForLoad"
    | "hover"
    | "selectOption"
    | "pressKey"
    | "fetchImages"
    | "screenshot"
    | "listTabs"
    | "switchTab";
  ref?: string;
  text?: string;
  url?: string;
  dir?: "up" | "down";
  amount?: number;
  timeoutMs?: number;
  /** selectOption: option value/text to choose. */
  value?: string;
  /** pressKey: key name or combination ("Enter", "Tab", "Control+a"). */
  key?: string;
  /** fetchImages: image refs (img1/vid1…) to fetch pixels for. */
  refs?: string[];
  /** switchTab: target tab id (webContents id string). */
  tabId?: string;
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
  /**
   * Open the browser panel (and optionally navigate to `url`) when no guest is
   * active yet, then resolve once a guest attaches (or reject/false on timeout).
   * Lets the agent START browsing without the user manually opening the panel.
   * Undefined → cannot auto-open (older host) → "no active panel" error as before.
   */
  openPanel?: (url?: string) => Promise<boolean>;
  /** List open browser tabs (for the agent's list_tabs). */
  listTabs?: () => Array<{ tabId: string; url: string; title: string; active: boolean }>;
  /** Make a tab the active automation target (for switch_tab). Returns true if found. */
  switchTab?: (tabId: string) => boolean;
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
  // Tab management is panel-global (operates on the guest registry, not a single
  // guest's driver) — handle it before resolving an active guest / driver.
  if (req.action === "listTabs") {
    return JSON.stringify(deps.listTabs ? deps.listTabs() : []);
  }
  if (req.action === "switchTab") {
    const ok = deps.switchTab && req.tabId ? deps.switchTab(req.tabId) : false;
    return JSON.stringify(ok ? { ok: true } : { ok: false, detail: `tab ${req.tabId ?? "?"} not found` });
  }

  let guest = deps.activeGuest();
  if (!guest || guest.isDestroyed()) {
    // No panel/tab yet — try to auto-open it (so the agent can start browsing
    // without the user manually opening the panel). For a navigate we pass the
    // target URL so the panel lands there directly; other actions open a blank
    // panel the agent can then navigate.
    if (deps.openPanel) {
      const opened = await deps.openPanel(req.action === "navigate" ? req.url : undefined).catch(() => false);
      if (opened) guest = deps.activeGuest();
    }
    if (!guest || guest.isDestroyed()) {
      return JSON.stringify({
        ok: false,
        detail: "no active browser panel — open the browser panel in the desktop app (or use browser_navigate to open one)",
      });
    }
    // If we just opened the panel via a navigate, the URL is already loading;
    // skip the redundant navigate below by returning early on success.
    if (req.action === "navigate") {
      return JSON.stringify({ ok: true, detail: "opened browser panel and navigated" });
    }
  }

  const policy = deps.policy();

  // Domain whitelist HARD-enforces (no approve bypass): it's opt-in — an empty
  // allowedDomains means "allow all", so isDomainAllowed only returns false when
  // the user explicitly configured a whitelist AND this host isn't on it. In
  // that case the user's intent is to block, so we block outright.
  const targetUrl = req.action === "navigate" ? req.url : safeUrl(guest);
  if (targetUrl && !isDomainAllowed(targetUrl, policy)) {
    return JSON.stringify({ ok: false, detail: `domain not allowed by whitelist: ${hostOf(targetUrl)}` });
  }

  // Sensitive action approval (click/type on payment/delete/credential surfaces).
  if (isSensitiveAction(req)) {
    const ok = await requestApproval(deps, `敏感浏览器操作:${req.action} ${req.ref ?? ""}`);
    if (!ok) return JSON.stringify({ ok: false, detail: "sensitive action declined" });
  }

  // Reuse the per-guest driver so the snapshot's ref map survives into the
  // following click/type calls (each is a separate worker request).
  const driver = driverForGuest(guest);
  let attachedForAction = false;
  try {
    attachedForAction = attachDebugger(guest);
    if (attachedForAction) automationAttachedGuests.add(guest.id);
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
      case "extractLinks":
        result = await driver.extractLinks();
        break;
      case "waitForLoad":
        result = await driver.waitForLoad(req.timeoutMs);
        break;
      case "hover":
        result = await driver.hover(req.ref ?? "");
        break;
      case "selectOption":
        result = await driver.selectOption(req.ref ?? "", req.value ?? "");
        break;
      case "pressKey":
        result = await driver.pressKey(req.key ?? "Enter", req.ref);
        break;
      case "fetchImages":
        result = await driver.fetchImages(req.refs ?? []);
        break;
      case "screenshot":
        result = await driver.screenshot(req.ref);
        break;
      default:
        result = { ok: false, detail: `unknown action: ${(req as { action: string }).action}` };
    }
    return JSON.stringify(result);
  } catch (e) {
    return JSON.stringify({ ok: false, detail: e instanceof Error ? e.message : String(e) });
  } finally {
    if (attachedForAction) {
      detachDebugger(guest);
      automationAttachedGuests.delete(guest.id);
      driver.resetDomains();
    }
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
