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
      expect(readAccountFeatures({ features, linkManagementEnabled: true })).toEqual({});
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
  test("only explicit features can grant access", () => {
    const otherFields = {
      linkManagementEnabled: true,
      githubLinkEnabled: true,
      capabilities: { links: true },
      relay: { enabled: true },
      cloudTarget: { enabled: true, cloudOrigin: "https://cloud.example" },
    };
    for (const payload of [undefined, null, [], otherFields, { ...otherFields, features: {} }]) {
      const features = readAccountFeatures(payload);
      expect(features).toEqual({});
      expect(
        Object.values(resolveAccountFeatures({ deployment: features, signedIn: true })).every(
          (feature) => feature.state === "hidden",
        ),
      ).toBe(true);
    }
    expect(readAccountFeatures({ ...otherFields, features: offered })).toEqual(offered);
  });
  test("phone feature declarations cannot choose navigation destinations", () => {
    for (const directoryPath of [
      "/devices",
      "/",
      "//evil.example",
      "https://evil.example",
      "/devices?token=secret",
    ]) {
      const features = parseAccountFeatures({
        "relay.phone": { version: 1, enabled: true, params: { directoryPath, token: "secret" } },
        "links.remote": { version: 1, enabled: true, params: { directoryPath } },
      });
      expect(features["relay.phone"]?.params).toBeUndefined();
      expect(features["links.remote"]?.params).toBeUndefined();
      expect(
        resolveAccountFeatures({ deployment: features, account: features, signedIn: true })[
          "relay.phone"
        ].params,
      ).toBeUndefined();
    }
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
