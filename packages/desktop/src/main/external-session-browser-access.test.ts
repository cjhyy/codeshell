import { beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { WebContents } from "electron";
import { defaultSessionBrowserBucket } from "./agent-run-browser-registration.js";
import {
  _resetGuests,
  activeGuestForSession,
  bucketForSession,
  guestRecordForId,
  partitionForSession,
  registerGuest,
  registerSessionBucket,
} from "./browser-driver/active-guest.js";
import { BuiltInBrowserHandoffGrants } from "./browser-runtime/built-in-handoff.js";
import { PanelAccessRequests } from "./browser-runtime/panel-access-request.js";

function panelGuest(id: number, url: string): WebContents {
  const guest = new EventEmitter() as EventEmitter & Record<string, unknown>;
  guest.id = id;
  guest.isDestroyed = () => false;
  guest.getURL = () => url;
  guest.getTitle = () => "Console";
  guest.focus = () => undefined;
  return guest as unknown as WebContents;
}

/** An external-runtime Session is registered the way AgentBridge registers it. */
function registerExternal(sessionId: string, projectId: string): string {
  const bucket = defaultSessionBrowserBucket(sessionId, projectId);
  registerSessionBucket(sessionId, bucket);
  return bucket;
}

function openPanelTab(sessionId: string, bucket: string): void {
  registerGuest({
    guest: panelGuest(11, "https://console.example.test/"),
    bucket,
    partition: partitionForSession(sessionId)!,
    windowId: 3,
  });
}

function grants() {
  return new BuiltInBrowserHandoffGrants({
    guestRecordForId,
    bucketForSession,
    authorizeGuest: (() => undefined) as never,
    releaseGuest: (() => undefined) as never,
    dispatchAction: (async () => JSON.stringify({ ok: true })) as never,
  });
}

describe("browser access of an external-runtime Session", () => {
  beforeEach(() => _resetGuests());

  test("shares the project profile with a native Session of that project", () => {
    registerExternal("external-1", "project-1");
    registerSessionBucket("native-1", "project-1::native-1");
    expect(partitionForSession("external-1")).toBe(partitionForSession("native-1"));
    expect(partitionForSession("external-1")).toBe("persist:browser:p:project-1");
  });

  test("a panel access request finds the tab open in this Session's BrowserPanel", async () => {
    const bucket = registerExternal("external-1", "project-1");
    // The renderer mounts the panel under bucketKey(projectId, sessionId).
    expect(bucket).toBe("project-1::external-1");
    openPanelTab("external-1", bucket);
    const handoff = grants();
    const prompts: Array<{ guestId: number; url: string }> = [];
    const requests = new PanelAccessRequests({
      status: (sessionId) => handoff.status(sessionId),
      show: (_windowId, prompt) => {
        prompts.push({ guestId: prompt.guestId, url: prompt.url });
        return true;
      },
      timeoutMs: 20,
    });

    const reply = JSON.parse(await requests.request("external-1"));

    expect(prompts).toEqual([{ guestId: 11, url: "https://console.example.test/" }]);
    // Asking is not consent: nobody answered, so nothing was granted.
    expect(reply.ok).toBe(false);
    expect(handoff.status("external-1").granted).toBe(false);
  });

  test("the panel tab is driven only after an explicit grant from its window", async () => {
    const bucket = registerExternal("external-1", "project-1");
    openPanelTab("external-1", bucket);
    const handoff = grants();

    // No grant: dispatch declines the claim, so the task-owned window is used.
    expect(await handoff.dispatch("external-1", { action: "snapshot" } as never)).toBeUndefined();
    expect(() =>
      handoff.grant({ sessionId: "external-1", guestId: 11, sourceWindowId: 4 }),
    ).toThrow("window that owns the tab");
    expect(handoff.grant({ sessionId: "external-1", guestId: 11, sourceWindowId: 3 }).granted).toBe(
      true,
    );
  });

  test("another Session of the same project cannot reach or be granted that tab", () => {
    const bucket = registerExternal("external-1", "project-1");
    registerSessionBucket("native-1", "project-1::native-1");
    registerExternal("external-2", "project-1");
    openPanelTab("external-1", bucket);

    expect(activeGuestForSession("external-1")?.guestId).toBe(11);
    expect(activeGuestForSession("native-1")).toBeNull();
    expect(activeGuestForSession("external-2")).toBeNull();
    const handoff = grants();
    for (const sessionId of ["native-1", "external-2"]) {
      expect(() => handoff.grant({ sessionId, guestId: 11, sourceWindowId: 3 })).toThrow(
        "does not belong to this task",
      );
    }
  });
});
