import { describe, expect, test } from "bun:test";
import type { PanelAppUpdateCheck } from "@cjhyy/code-shell-core";
import { createPanelAppUpdateService } from "./panel-app-update-service.js";

const app = {
  id: "video-studio",
  version: "0.6.1",
  source: { kind: "git" as const, url: "https://github.com/acme/panels.git", ref: "main" },
  lastUpdated: "2026-09-16T00:00:00.000Z",
};
function result(overrides: Partial<PanelAppUpdateCheck> = {}): PanelAppUpdateCheck {
  return {
    id: app.id,
    currentVersion: app.version,
    latestVersion: "0.6.2",
    status: "update-available",
    checkedAt: "2026-09-16T00:00:00.000Z",
    sourceKind: "git",
    ...overrides,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("Panel App update discovery cache", () => {
  test("caches for five minutes and manual refresh bypasses the cache", async () => {
    let calls = 0;
    let now = 0;
    const service = createPanelAppUpdateService({
      getInstalled: async () => app,
      now: () => now,
      check: async () => {
        calls++;
        return result();
      },
    });
    expect((await service.check(app.id)).status).toBe("update-available");
    await service.check(app.id);
    expect(calls).toBe(1);
    await service.check(app.id, true);
    expect(calls).toBe(2);
    now = 5 * 60_000;
    await service.check(app.id);
    expect(calls).toBe(3);
  });

  test("shares concurrent checks including manual refresh", async () => {
    let calls = 0;
    const request = deferred<PanelAppUpdateCheck>();
    const service = createPanelAppUpdateService({
      getInstalled: async () => app,
      check: async () => {
        calls++;
        return request.promise;
      },
    });
    const requests = [service.check(app.id), service.check(app.id, true)];
    request.resolve(result());
    expect((await Promise.all(requests)).map((item) => item.status)).toEqual([
      "update-available",
      "update-available",
    ]);
    expect(calls).toBe(1);
  });

  test("retries failed checks after thirty seconds without reporting latest", async () => {
    let now = 0;
    let calls = 0;
    const service = createPanelAppUpdateService({
      getInstalled: async () => app,
      now: () => now,
      check: async () => {
        calls++;
        throw new Error("offline");
      },
    });
    expect(await service.check(app.id)).toMatchObject({ status: "error", message: "offline" });
    await service.check(app.id);
    expect(calls).toBe(1);
    now = 30_000;
    await service.check(app.id);
    expect(calls).toBe(2);
  });

  test("source changes and same-version reinstalls invalidate cached results", async () => {
    let installed = { ...app };
    let calls = 0;
    const service = createPanelAppUpdateService({
      getInstalled: async () => installed,
      check: async () => {
        calls++;
        return result();
      },
    });
    await service.check(app.id);
    installed = { ...installed, source: { ...installed.source, ref: "release" } };
    await service.check(app.id);
    installed = { ...installed, lastUpdated: "2026-09-16T01:00:00.000Z" };
    await service.check(app.id);
    expect(calls).toBe(3);
  });

  test("a response from an older installation cannot restore its update badge", async () => {
    let installed = { ...app };
    const oldRequest = deferred<PanelAppUpdateCheck>();
    let calls = 0;
    const service = createPanelAppUpdateService({
      getInstalled: async () => installed,
      check: async () =>
        ++calls === 1
          ? oldRequest.promise
          : result({ currentVersion: "0.6.2", status: "up-to-date" }),
    });
    const pending = service.check(app.id);
    await new Promise((done) => setTimeout(done, 0));
    installed = { ...installed, version: "0.6.2" };
    service.invalidate(app.id);
    expect((await service.check(app.id)).status).toBe("up-to-date");
    oldRequest.resolve(result());
    expect((await pending).status).toBe("error");
    expect((await service.check(app.id)).status).toBe("up-to-date");
    expect(calls).toBe(2);
  });

  test("uninstalled apps never return a cached available update", async () => {
    let installed = true;
    const service = createPanelAppUpdateService({
      getInstalled: async () => (installed ? app : undefined),
      check: async () => result(),
    });
    await service.check(app.id);
    installed = false;
    expect((await service.check(app.id)).status).toBe("error");
  });

  test("rejects invalid IDs before reading installation data", async () => {
    let calls = 0;
    const service = createPanelAppUpdateService({
      getInstalled: async () => {
        calls++;
        return undefined;
      },
      check: async () => result(),
    });
    await expect(service.check("../escape")).rejects.toThrow();
    expect(calls).toBe(0);
  });
});
