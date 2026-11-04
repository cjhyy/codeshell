import { describe, expect, test } from "bun:test";
import {
  accountRegistrationUrl,
  parseAccountFeatures,
  readAccountFeatures,
  resolveAccountFeatures,
} from "./features.js";
const offered = { "links.remote": { version: 1, enabled: true } } as const;
describe("account feature contract", () => {
  test("unknown versions, malformed maps and invalid cloud destinations fail closed", () => {
    for (const features of [
      null,
      [],
      { "links.remote": { version: 2, enabled: true } },
      { "links.remote": { version: 1, enabled: "true" } },
    ])
      expect(readAccountFeatures({ features, linkManagementEnabled: true }, "deployment")).toEqual(
        {},
      );
    for (const cloudOrigin of [
      "javascript:alert(1)",
      "https://user:secret@cloud.example",
      "https://cloud.example/path",
      "https://cloud.example/?token=secret",
    ])
      expect(
        parseAccountFeatures({
          "cloud.projects": { version: 1, enabled: true, params: { cloudOrigin } },
        }),
      ).toEqual({});
    expect(
      parseAccountFeatures({
        "links.remote": { version: 1, enabled: true, params: { token: "secret" } },
        unknown: { version: 1, enabled: true },
      }),
    ).toEqual(offered);
  });
  test("legacy projection only applies when features is absent", () => {
    const legacy = readAccountFeatures(
      {
        githubLinkEnabled: true,
        relay: { enabled: true },
        cloudTarget: { enabled: true, cloudOrigin: "https://cloud.example" },
      },
      "deployment",
    );
    expect(legacy["links.remote"]?.enabled).toBe(true);
    expect(legacy["devices.dispatch"]?.enabled).toBe(true);
    expect(legacy["devices.handoff"]).toBeUndefined();
    expect(legacy["devices.directory"]).toBeUndefined();
    expect(
      readAccountFeatures({ capabilities: { links: false } }, "account", legacy)["links.remote"]
        ?.enabled,
    ).toBe(true);
    expect(readAccountFeatures({ features: {} }, "account", legacy)).toEqual({});
  });
  test("all four states honor account denial, host support, offline state and prerequisites", () => {
    const base = { deployment: offered, signedIn: false };
    expect(resolveAccountFeatures(base)["links.remote"].state).toBe("sign-in");
    expect(resolveAccountFeatures({ ...base, signedIn: true })["links.remote"]).toMatchObject({
      state: "pending",
      reason: "service_unreachable",
    });
    expect(
      resolveAccountFeatures({ ...base, signedIn: true, account: offered })["links.remote"].state,
    ).toBe("ready");
    expect(
      resolveAccountFeatures({ ...base, signedIn: true, account: offered, reachable: false })[
        "links.remote"
      ].state,
    ).toBe("pending");
    expect(
      resolveAccountFeatures({ ...base, signedIn: true, account: {} })["links.remote"].state,
    ).toBe("hidden");
    expect(resolveAccountFeatures({ ...base, supported: [] })["links.remote"].state).toBe("hidden");
    expect(
      resolveAccountFeatures({
        ...base,
        signedIn: true,
        account: offered,
        local: { "links.remote": { ready: false, reason: "storage_error" } },
      })["links.remote"].reason,
    ).toBe("storage_error");
    expect(resolveAccountFeatures({ signedIn: false })["links.remote"].state).toBe("hidden");
  });
  test("registration is a fixed origin-bound path", () => {
    expect(accountRegistrationUrl("https://account.example")).toBe(
      "https://account.example/register",
    );
    for (const value of [
      "https://account.example/evil",
      "https://user:pass@account.example",
      "https://account.example?redirect=evil",
      "javascript:alert(1)",
    ])
      expect(() => accountRegistrationUrl(value)).toThrow();
  });
});
