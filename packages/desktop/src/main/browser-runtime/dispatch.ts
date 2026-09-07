/** Runtime-only dispatch for interactive engine sessions. */

import type { ChildBrowserHost } from "../browser-driver/intercept.js";
import type { BrowserBridge } from "@cjhyy/code-shell-core";
import {
  dispatchBrowserBridgeAction,
  type BrowserActionRequest,
} from "../browser-driver/automation-host.js";
import { browserRuntime, type BrowserRuntimeLike } from "./runtime.js";
import { builtInTabClaimBackend } from "./built-in-handoff.js";
import { chromeExtensionBackend } from "./chrome-extension-singleton.js";
import { interactiveBrowserRuntimeOwner } from "./dispatch-owner.js";

export { interactiveBrowserRuntimeOwner } from "./dispatch-owner.js";

// Positive ownership: unknown or released child bindings cannot allocate a target.
// Pending calls retain this object after removal, so cancellation cannot expire.
const activeChildOwners = new Map<string, { released: boolean }>();
function childOwner(sessionId: string, child: ChildBrowserHost): string {
  return `${interactiveBrowserRuntimeOwner(sessionId)}:child:${child.sourceSessionId}:${child.bindingId}`;
}

/** The worker emits activation only after obtaining the child's writer lease. */
export function activateChildBrowserRuntime(sessionId: string, child: ChildBrowserHost): void {
  const owner = childOwner(sessionId, child);
  if (!activeChildOwners.has(owner)) activeChildOwners.set(owner, { released: false });
}

/** Release only the target allocated by this child run, including a resumed run. */
export function releaseChildBrowserRuntime(
  sessionId: string,
  child: ChildBrowserHost,
  runtime: BrowserRuntimeLike = browserRuntime,
): void {
  const owner = childOwner(sessionId, child);
  const lifetime = activeChildOwners.get(owner);
  if (lifetime) lifetime.released = true;
  activeChildOwners.delete(owner);
  runtime.close(owner);
}

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
  child?: ChildBrowserHost,
): Promise<string> {
  const ownerId = child ? childOwner(sessionId, child) : interactiveBrowserRuntimeOwner(sessionId);
  const lifetime = child ? activeChildOwners.get(ownerId) : undefined;
  if (child && (!lifetime || lifetime.released)) {
    return JSON.stringify({
      ok: false,
      code: "TARGET_CLOSED",
      retryable: false,
      detail: "child browser run has ended",
    });
  }
  if (request.action === "requestTakeover") {
    if (!child && builtInTabClaimBackend.status(sessionId).granted) {
      return JSON.stringify({
        ok: true,
        code: "NEEDS_HUMAN",
        retryable: false,
        detail: "the granted built-in browser tab is already user-visible",
      });
    }
    if (!child && chromeExtensionBackend.status(sessionId).granted) {
      return JSON.stringify({
        ok: true,
        code: "NEEDS_HUMAN",
        retryable: false,
        detail: "the granted Chrome tab is already user-visible",
      });
    }

    const lease = await runtime.acquire({
      ownerId,
      profileId: sessionId,
      visibility: "full",
      title: "CodeShell Browser Runtime — 需要你接管",
    });
    try {
      if (child && lifetime?.released) {
        runtime.close(ownerId);
        return JSON.stringify({
          ok: false,
          code: "TARGET_CLOSED",
          detail: "child browser run has ended",
        });
      }
      await lease.show();
      return JSON.stringify({
        ok: true,
        code: "NEEDS_HUMAN",
        retryable: false,
        detail: "showing the same task-owned page operated by browser tools",
      });
    } catch (error) {
      return JSON.stringify({
        ok: false,
        code: "FAILED",
        retryable: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      lease.release();
    }
  }

  if (!child) {
    const handedOff = await builtInTabClaimBackend.dispatch(sessionId, request);
    if (handedOff !== undefined) return handedOff;
    const chrome = await chromeExtensionBackend.dispatch(sessionId, request);
    if (chrome !== undefined) return chrome;
  }
  const lease = await runtime.acquire({
    ownerId,
    profileId: sessionId,
    visibility: "milestones",
    title: "CodeShell Browser Runtime — 需要你接管",
  });
  try {
    if (child && lifetime?.released) {
      runtime.close(ownerId);
      return JSON.stringify({
        ok: false,
        code: "TARGET_CLOSED",
        detail: "child browser run has ended",
      });
    }
    return await dispatchBrowserBridgeAction(request, lease.bridge);
  } finally {
    lease.release();
  }
}

/**
 * Direct ToolContext bridge for sessions whose agent loop lives in Desktop
 * main. It intentionally dispatches through the same ownership/handoff router
 * as worker-originated browser actions.
 */
export function interactiveBrowserBridgeForSession(sessionId: string): BrowserBridge {
  const call = async <T>(request: BrowserActionRequest): Promise<T> => {
    const json = await dispatchInteractiveBrowserRuntimeAction(sessionId, request);
    return JSON.parse(json) as T;
  };
  return {
    requestHumanTakeover: () => call({ action: "requestTakeover" }),
    snapshot: () => call({ action: "snapshot" }),
    click: (ref) => call({ action: "click", ref }),
    type: (ref, text) => call({ action: "type", ref, text }),
    navigate: (url) => call({ action: "navigate", url }),
    scroll: (dir, amount) => call({ action: "scroll", dir, amount }),
    readContent: (options) =>
      call({ action: "readContent", cursor: options?.cursor, maxChars: options?.maxChars }),
    extractLinks: () => call({ action: "extractLinks" }),
    waitForLoad: (timeoutMs) => call({ action: "waitForLoad", timeoutMs }),
    hover: (ref) => call({ action: "hover", ref }),
    selectOption: (ref, value) => call({ action: "selectOption", ref, value }),
    pressKey: (key, ref) => call({ action: "pressKey", key, ref }),
    fetchImages: (refs) => call({ action: "fetchImages", refs }),
    screenshot: (ref) => call({ action: "screenshot", ref }),
    listTabs: () => call({ action: "listTabs" }),
    switchTab: (tabId) => call({ action: "switchTab", tabId }),
  };
}
