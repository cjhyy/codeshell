import { describe, it, expect } from "bun:test";
import { resolveUninstallTarget } from "./uninstallTarget";

describe("resolveUninstallTarget", () => {
  it("splits a marketplace install key into name + marketplace", () => {
    expect(
      resolveUninstallTarget({
        name: "superpowers",
        installKey: "superpowers@official",
        marketplace: "official",
        installationKind: "marketplace",
      }),
    ).toEqual({
      uninstallable: true,
      kind: "marketplace",
      pluginName: "superpowers",
      marketplaceName: "official",
    });
  });

  it("marks a local install (no marketplace) uninstallable via the local path", () => {
    expect(
      resolveUninstallTarget({
        name: "mimi-video",
        installKey: "mimi-video@local",
        marketplace: null,
        installationKind: "direct",
      }),
    ).toEqual({ uninstallable: true, kind: "local", pluginName: "mimi-video" });
  });

  // Direct installs and a marketplace named local share the key suffix.
  it("routes validated direct installs to the local path", () => {
    expect(
      resolveUninstallTarget({
        name: "mimi-video",
        installKey: "mimi-video@local",
        marketplace: "local",
        installationKind: "direct",
      }),
    ).toEqual({ uninstallable: true, kind: "local", pluginName: "mimi-video" });
  });

  it("resolves a local plugin whose installKey is the bare name", () => {
    expect(
      resolveUninstallTarget({
        name: "mine",
        installKey: "mine",
        marketplace: null,
        installationKind: "direct",
      }),
    ).toEqual({ uninstallable: true, kind: "local", pluginName: "mine" });
  });

  it("prefers the installKey split over the name field when both present", () => {
    expect(
      resolveUninstallTarget({
        name: "x",
        installKey: "real-name@mkt",
        marketplace: "mkt",
        installationKind: "marketplace",
      }),
    ).toEqual({
      uninstallable: true,
      kind: "marketplace",
      pluginName: "real-name",
      marketplaceName: "mkt",
    });
  });
});

it("refuses missing, unknown and contradictory marketplace source metadata", () => {
  for (const installationKind of [undefined, "unknown"] as const) {
    expect(
      resolveUninstallTarget({
        name: "p",
        installKey: "p@local",
        marketplace: "local",
        installationKind,
      }),
    ).toEqual({ uninstallable: false });
  }
  expect(
    resolveUninstallTarget({
      name: "p",
      installKey: "p@one",
      marketplace: "two",
      installationKind: "marketplace",
    }),
  ).toEqual({ uninstallable: false });
});
