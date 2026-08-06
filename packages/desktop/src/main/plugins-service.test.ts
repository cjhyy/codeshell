import { describe, expect, test } from "bun:test";
import { PluginInstallError } from "@cjhyy/code-shell-core";
import { updatePluginEntry } from "./plugins-service.js";

function services(
  catalog: Array<{ installKey: string; name: string; marketplace: string | null }>,
) {
  const calls: string[] = [];
  return {
    calls,
    value: {
      listCatalog: () => catalog,
      updateLocal: async (name: string, installedAt: string, force: boolean) => {
        calls.push(`local:${name}:${installedAt}:${force}`);
        return { updated: true, reason: "local" };
      },
      refreshMarket: async (name: string) => {
        calls.push(`refresh:${name}`);
        return { ok: true as const };
      },
      installFromMarket: async (name: string, marketplace: string) => {
        calls.push(`market:${name}@${marketplace}`);
        return { ok: true as const };
      },
      invalidateSkills: () => calls.push("invalidate"),
      now: () => "2026-08-06T08:00:00.000Z",
    },
  };
}

describe("updatePluginEntry", () => {
  test("refreshes and reinstalls an exact marketplace plugin", async () => {
    const fake = services([
      {
        installKey: "media-downloader@mimi-plugins",
        name: "media-downloader",
        marketplace: "mimi-plugins",
      },
    ]);

    await expect(updatePluginEntry("media-downloader@mimi-plugins", fake.value)).resolves.toEqual({
      updated: true,
      reason: "refreshed mimi-plugins and reinstalled media-downloader",
    });
    expect(fake.calls).toEqual([
      "refresh:mimi-plugins",
      "market:media-downloader@mimi-plugins",
      "invalidate",
    ]);
  });

  test("keeps the old bare-name renderer compatible when the name is unique", async () => {
    const fake = services([
      {
        installKey: "media-downloader@mimi-plugins",
        name: "media-downloader",
        marketplace: "mimi-plugins",
      },
    ]);

    await updatePluginEntry("media-downloader", fake.value);
    expect(fake.calls).toContain("market:media-downloader@mimi-plugins");
  });

  test("routes local installs through their recorded source updater", async () => {
    const fake = services([
      { installKey: "mimi-video@local", name: "mimi-video", marketplace: "local" },
    ]);

    await expect(updatePluginEntry("mimi-video@local", fake.value)).resolves.toEqual({
      updated: true,
      reason: "local",
    });
    expect(fake.calls).toEqual(["local:mimi-video:2026-08-06T08:00:00.000Z:true"]);
  });

  test("fails closed for an ambiguous legacy bare name", async () => {
    const fake = services([
      { installKey: "same@one", name: "same", marketplace: "one" },
      { installKey: "same@two", name: "same", marketplace: "two" },
    ]);

    await expect(updatePluginEntry("same", fake.value)).rejects.toBeInstanceOf(PluginInstallError);
    expect(fake.calls).toEqual([]);
  });

  test("does not reinstall when refreshing the marketplace fails", async () => {
    const fake = services([{ installKey: "media@shop", name: "media", marketplace: "shop" }]);
    fake.value.refreshMarket = async (name: string) => {
      fake.calls.push(`refresh:${name}`);
      return { ok: false as const, error: "offline" };
    };

    await expect(updatePluginEntry("media@shop", fake.value)).rejects.toThrow("offline");
    expect(fake.calls).toEqual(["refresh:shop"]);
  });
});
