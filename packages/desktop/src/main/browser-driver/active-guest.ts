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

/** Test/teardown helper. */
export function _resetGuests(): void {
  guests.clear();
  active = null;
}
