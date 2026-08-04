/** Runtime-only dispatch for interactive engine sessions. */

import {
  dispatchBrowserBridgeAction,
  type BrowserActionRequest,
} from "../browser-driver/automation-host.js";
import { browserRuntime, type BrowserRuntimeLike } from "./runtime.js";
import { builtInBrowserHandoffGrants } from "./built-in-handoff.js";
import { chromeExtensionRuntimeService } from "./chrome-extension-singleton.js";
import { interactiveBrowserRuntimeOwner } from "./dispatch-owner.js";

export { interactiveBrowserRuntimeOwner } from "./dispatch-owner.js";

/**
 * Execute one browser tool request against a runtime-owned target.
 *
 * There is intentionally no activeGuest/BrowserPanel parameter here. The only
 * way a built-in tab can enter this path in the future is as an explicit,
 * user-authorized runtime backend.
 */
export async function dispatchInteractiveBrowserRuntimeAction(
  sessionId: string,
  request: BrowserActionRequest,
  runtime: BrowserRuntimeLike = browserRuntime,
): Promise<string> {
  const handedOff = await builtInBrowserHandoffGrants.dispatch(sessionId, request);
  if (handedOff !== undefined) return handedOff;
  const chrome = await chromeExtensionRuntimeService.dispatch(sessionId, request);
  if (chrome !== undefined) return chrome;

  const ownerId = interactiveBrowserRuntimeOwner(sessionId);
  const lease = await runtime.acquire({
    ownerId,
    profileId: ownerId,
    visibility: "milestones",
    title: "CodeShell Browser Runtime — 需要你接管",
  });
  try {
    return await dispatchBrowserBridgeAction(request, lease.bridge);
  } finally {
    lease.release();
  }
}
