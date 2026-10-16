import { describe, expect, test } from "bun:test";
import { PanelAppDiscoveryQueue } from "./panel-app-discovery-queue.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("Panel App project discovery ordering", () => {
  test("overlapping readers both receive complete snapshots and publish in order", async () => {
    const queue = new PanelAppDiscoveryQueue();
    const firstSnapshot = deferred<string[]>();
    const publications: string[][] = [];
    let nextStarted = false;
    const first = queue.read("/project", async () => {
      const apps = await firstSnapshot.promise;
      publications.push(apps);
      return apps;
    });
    const next = queue.read("/project", async () => {
      nextStarted = true;
      const apps = ["design-v2", "jobs", "download", "video"];
      publications.push(apps);
      return apps;
    });
    await Promise.resolve();
    expect(nextStarted).toBe(false);
    firstSnapshot.resolve(["design-v1", "jobs", "download", "video"]);
    const results = await Promise.all([first, next]);
    expect(results).toEqual([
      ["design-v1", "jobs", "download", "video"],
      ["design-v2", "jobs", "download", "video"],
    ]);
    expect(publications).toEqual(results);
    expect(nextStarted).toBe(true);
  });

  test("one project's slow discovery does not block another project", async () => {
    const queue = new PanelAppDiscoveryQueue();
    const slow = deferred<string[]>();
    const first = queue.read("/first", () => slow.promise);
    expect(await queue.read("/second", async () => ["other-panel"])).toEqual(["other-panel"]);
    slow.resolve(["first-panel"]);
    expect(await first).toEqual(["first-panel"]);
  });

  test("a failed read rejects its caller and a later read can recover", async () => {
    const queue = new PanelAppDiscoveryQueue();
    const failed = queue.read("/project", async () => {
      throw new Error("package temporarily unavailable");
    });
    const recovered = queue.read("/project", async () => ["recovered-panel"]);
    await expect(failed).rejects.toThrow("package temporarily unavailable");
    expect(await recovered).toEqual(["recovered-panel"]);
    expect(await queue.read("/project", async () => ["fresh-panel"])).toEqual(["fresh-panel"]);
  });
});
