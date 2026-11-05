import { describe, expect, test } from "bun:test";
import type { WebContents } from "electron";
import type { RestoreCookieCredentialInput } from "./cookie-credential-browser.js";
import {
  injectCredentialIntoSessionBrowser,
  type InjectCredentialIntoSessionDeps,
} from "./inject-credential-browser.js";

const restored = { count: 44, expired: 2, failed: 0, failures: [], verified: 44 };

function harness(options: { guest?: boolean; partition?: string | null; panels?: string[] }) {
  const guestSession = { id: "guest-session" } as unknown as Electron.Session;
  const restoreCalls: RestoreCookieCredentialInput[] = [];
  const reloaded: string[] = [];
  const deps: InjectCredentialIntoSessionDeps = {
    activeGuestForSession: () =>
      options.guest
        ? {
            guest: { session: guestSession } as unknown as WebContents,
            bucket: "project::s-1",
            partition: "persist:browser:p:project",
            guestId: 12,
          }
        : null,
    partitionForSession: () =>
      options.partition === undefined ? "persist:browser:p:project" : options.partition,
    bucketsWithLiveGuestsForPartition: () => options.panels ?? [],
    restore: async (input) => {
      restoreCalls.push(input);
      return restored;
    },
  };
  const input = {
    sessionId: "s-1",
    bucket: "project::s-1",
    credentialId: "bilibili",
    credentialScope: "full" as const,
    resolved: {} as RestoreCookieCredentialInput["resolved"],
    reloadBucket: (bucket: string) => reloaded.push(bucket),
  };
  return { deps, input, restoreCalls, reloaded, guestSession };
}

describe("injectCredentialIntoSessionBrowser", () => {
  test("writes through the mounted panel tab and names the jar it wrote", async () => {
    const h = harness({ guest: true, panels: ["project::s-1"] });
    const report = await injectCredentialIntoSessionBrowser(h.input, h.deps);
    expect(report).toEqual({
      ok: true,
      ...restored,
      partition: "persist:browser:p:project",
      target: "panel-tab",
      reloadedPanels: 1,
    });
    expect(h.restoreCalls[0]!.targetSession).toBe(h.guestSession);
  });

  test("without a mounted tab it writes the jar and says so", async () => {
    const h = harness({});
    const report = await injectCredentialIntoSessionBrowser(h.input, h.deps);
    expect(report).toMatchObject({ target: "partition-only", reloadedPanels: 0 });
    expect(h.restoreCalls[0]!.targetSession).toBe("persist:browser:p:project");
    expect(h.reloaded).toEqual(["project::s-1"]);
  });

  test("reloads every panel sharing the project jar, not only the caller's", async () => {
    const h = harness({ guest: true, panels: ["project::s-1", "project::s-2"] });
    await injectCredentialIntoSessionBrowser(h.input, h.deps);
    expect(h.reloaded).toEqual(["project::s-1", "project::s-2"]);
  });

  test("refuses when the session has no browser jar", async () => {
    const h = harness({ partition: null });
    await expect(injectCredentialIntoSessionBrowser(h.input, h.deps)).rejects.toThrow(
      "no browser partition registered for session s-1",
    );
    expect(h.restoreCalls).toEqual([]);
  });
});
