/** Runtime-only dispatch for interactive engine sessions. */

import {
  dispatchBrowserBridgeAction,
  type BrowserActionRequest,
} from "../browser-driver/automation-host.js";
import { browserRuntime, type BrowserRuntimeLike } from "./runtime.js";
import { builtInTabClaimBackend } from "./built-in-handoff.js";
import { chromeExtensionBackend } from "./chrome-extension-singleton.js";
import { interactiveBrowserRuntimeOwner } from "./dispatch-owner.js";

export { interactiveBrowserRuntimeOwner } from "./dispatch-owner.js";

/**
 * Execute one browser tool request against a runtime-owned target.
 *
 * The default target is a task-owned background in-app tab sharing this
 * session's BrowserPanel profile. Existing user-opened tabs still require an
 * explicit claim and are never selected from focus alone.
 */
export async function dispatchInteractiveBrowserRuntimeAction(
  sessionId: string,
  request: BrowserActionRequest,
  runtime: BrowserRuntimeLike = browserRuntime,
): Promise<string> {
  const handedOff = await builtInTabClaimBackend.dispatch(sessionId, request);
  if (handedOff !== undefined) return handedOff;
  const chrome = await chromeExtensionBackend.dispatch(sessionId, request);
  if (chrome !== undefined) return chrome;

  const ownerId = interactiveBrowserRuntimeOwner(sessionId);
  const lease = await runtime.acquire({
    ownerId,
    profileId: sessionId,
    visibility: "milestones",
    title: "CodeShell Browser Runtime — 需要你接管",
  });
  try {
    return await dispatchBrowserBridgeAction(request, lease.bridge);
  } finally {
    lease.release();
  }
}
