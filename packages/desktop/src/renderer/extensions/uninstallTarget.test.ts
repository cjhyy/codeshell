import { describe, it, expect } from "bun:test";
import { resolveUninstallTarget } from "./uninstallTarget";

describe("resolveUninstallTarget", () => {
  it("splits a marketplace install key into name + marketplace", () => {
    expect(
      resolveUninstallTarget({ name: "superpowers", installKey: "superpowers@official", marketplace: "official" }),
    ).toEqual({ uninstallable: true, pluginName: "superpowers", marketplaceName: "official" });
  });

  it("marks local / direct-github installs (no marketplace) as not uninstallable", () => {
    expect(
      resolveUninstallTarget({ name: "mine", installKey: "mine", marketplace: null }),
    ).toEqual({ uninstallable: false });
  });

  it("prefers the installKey split over the name field when both present", () => {
    expect(
      resolveUninstallTarget({ name: "x", installKey: "real-name@mkt", marketplace: "mkt" }),
    ).toEqual({ uninstallable: true, pluginName: "real-name", marketplaceName: "mkt" });
  });
});
