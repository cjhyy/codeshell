/**
 * Tracks the browser-panel <webview> guest webContents that automation should
 * drive. MVP: the most-recently-attached / most-recently-focused guest is the
 * target (single active tab). `index.ts`'s did-attach-webview registers guests
 * here; the automation host reads activeGuest().
 *
 * Kept tiny and dependency-free so agent-bridge / automation-host can import it
 * without pulling in window/panel code.
 */

import type { WebContents } from "electron";

let active: WebContents | null = null;
const guests = new Set<WebContents>();

/** Register a freshly-attached guest and make it the active automation target. */
export function registerGuest(guest: WebContents): void {
  guests.add(guest);
  active = guest;
  guest.once("destroyed", () => {
    guests.delete(guest);
    if (active === guest) active = mostRecentLiveGuest();
  });
  // Following the focus heuristic: a guest that navigates / gains focus becomes
  // the target, so multi-tab panels drive the tab the user last touched.
  guest.on("focus", () => {
    active = guest;
  });
}

/** The current automation target, or null if no live browser panel/tab. */
export function activeGuest(): WebContents | null {
  if (active && !active.isDestroyed()) return active;
  active = mostRecentLiveGuest();
  return active;
}

function mostRecentLiveGuest(): WebContents | null {
  let last: WebContents | null = null;
  for (const g of guests) if (!g.isDestroyed()) last = g;
  return last;
}

/** One browser tab as the agent sees it. tabId is the webContents.id (string). */
export interface GuestTab {
  tabId: string;
  url: string;
  title: string;
  active: boolean;
}

/** List all live guest tabs (for the agent's list_tabs). tabId = webContents.id. */
export function listGuests(): GuestTab[] {
  const cur = activeGuest();
  const out: GuestTab[] = [];
  for (const g of guests) {
    if (g.isDestroyed()) continue;
    out.push({
      tabId: String(g.id),
      url: safe(() => g.getURL()) ?? "",
      title: safe(() => g.getTitle()) ?? "",
      active: g === cur,
    });
  }
  return out;
}

/** Resolve a tabId (webContents.id string) back to its live guest, or null. */
export function guestById(tabId: string): WebContents | null {
  const id = Number(tabId);
  if (!Number.isFinite(id)) return null;
  for (const g of guests) if (g.id === id && !g.isDestroyed()) return g;
  return null;
}

/** Make a tab active by focusing it (drives the existing focus heuristic). */
export function focusGuest(tabId: string): boolean {
  const g = guestById(tabId);
  if (!g) return false;
  active = g;
  try {
    g.focus();
  } catch {
    /* focus best-effort — `active` is already updated */
  }
  return true;
}

function safe<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

/** Test/teardown helper. */
export function _resetGuests(): void {
  guests.clear();
  active = null;
}
