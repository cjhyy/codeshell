import { describe, it, expect } from "bun:test";
import { resolveUninstallTarget } from "./uninstallTarget";

describe("resolveUninstallTarget", () => {
  it("splits a marketplace install key into name + marketplace", () => {
    expect(
      resolveUninstallTarget({ name: "superpowers", installKey: "superpowers@official", marketplace: "official" }),
    ).toEqual({ uninstallable: true, kind: "marketplace", pluginName: "superpowers", marketplaceName: "official" });
  });

  it("marks a local install (no marketplace) uninstallable via the local path", () => {
    expect(
      resolveUninstallTarget({ name: "mimi-video", installKey: "mimi-video@local", marketplace: null }),
    ).toEqual({ uninstallable: true, kind: "local", pluginName: "mimi-video" });
  });

  // Regression: listPlugins splits "mimi-video@local" → marketplace === "local"
  // (a truthy string, NOT null). The old `!p.marketplace` check let this fall
  // through to the marketplace path, which deleted the cache dir and left the
  // real ~/.code-shell/plugins/mimi-video intact — so uninstall appeared to do
  // nothing and reinstall reported "already installed".
  it("routes marketplace==='local' to the local path (the real runtime value)", () => {
    expect(
      resolveUninstallTarget({ name: "mimi-video", installKey: "mimi-video@local", marketplace: "local" }),
    ).toEqual({ uninstallable: true, kind: "local", pluginName: "mimi-video" });
  });

  it("resolves a local plugin whose installKey is the bare name", () => {
    expect(
      resolveUninstallTarget({ name: "mine", installKey: "mine", marketplace: null }),
    ).toEqual({ uninstallable: true, kind: "local", pluginName: "mine" });
  });

  it("prefers the installKey split over the name field when both present", () => {
    expect(
      resolveUninstallTarget({ name: "x", installKey: "real-name@mkt", marketplace: "mkt" }),
    ).toEqual({ uninstallable: true, kind: "marketplace", pluginName: "real-name", marketplaceName: "mkt" });
  });
});
