import { describe, expect, test } from "bun:test";
import {
  cloudWorkbenchPartition,
  createCloudWorkbenchNavigation,
  isCloudWorkbenchOrigin,
  normalizeCloudWorkbenchAddress,
} from "./cloud-workbench-policy.js";

describe("cloud workbench boundary", () => {
  test("accepts HTTPS origins and loopback development entries", () => {
    expect(normalizeCloudWorkbenchAddress(" https://CLOUD.example:443/ ")).toBe(
      "https://cloud.example/",
    );
    expect(normalizeCloudWorkbenchAddress("http://127.0.0.1:8790")).toBe("http://127.0.0.1:8790/");
  });
  test("rejects setup credentials, paths and unsafe transports", () => {
    for (const value of [
      "https://cloud.example/#setup=secret",
      "https://cloud.example/?token=secret",
      "https://user:secret@cloud.example",
      "https://cloud.example/projects/1",
      "http://cloud.example",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "https://cloud.example\\@evil.example",
      null,
    ])
      expect(() => normalizeCloudWorkbenchAddress(value)).toThrow();
  });
  test("keeps each cloud origin's cookies separate from desktop and other hosts", () => {
    const partition = cloudWorkbenchPartition("https://cloud.example/");
    expect(partition).toStartWith("persist:codeshell-cloud-");
    expect(cloudWorkbenchPartition("https://cloud.example/path")).toBe(partition);
    expect(cloudWorkbenchPartition("https://other.example/")).not.toBe(partition);
    expect(cloudWorkbenchPartition("https://cloud.example:8443/")).not.toBe(partition);
  });
  test("only allows same-origin web navigation, including a project's routes", () => {
    expect(
      isCloudWorkbenchOrigin("https://cloud.example/", "https://cloud.example/projects/123"),
    ).toBe(true);
    for (const target of [
      "https://cloud.example.evil.example",
      "http://cloud.example",
      "file:///tmp/file",
      "https://user@cloud.example/",
      "https://cloud.example:8443/",
    ])
      expect(isCloudWorkbenchOrigin("https://cloud.example/", target)).toBe(false);
  });
});

describe("bounded Link navigation", () => {
  const cloud = "https://cloud.example/";
  const issuer = "https://link.example";
  const state = "s".repeat(43);
  const authorization = (changes: Record<string, string> = {}) =>
    issuer +
    "/oauth/authorize?" +
    new URLSearchParams({
      response_type: "code",
      client_id: "client",
      redirect_uri: cloud + "link/callback",
      state,
      code_challenge: "c".repeat(43),
      code_challenge_method: "S256",
      ...changes,
    });
  test("allows login/consent and matching return only during the originating flow", () => {
    const policy = createCloudWorkbenchNavigation(cloud);
    expect(policy.allows(cloud, issuer + "/login")).toBe(false);
    expect(policy.allows(cloud, authorization())).toBe(true);
    expect(policy.allows(cloud, issuer + "/login?returnTo=%2Foauth%2Fauthorize")).toBe(true);
    expect(policy.allows(issuer + "/login", authorization())).toBe(true);
    expect(policy.allows(issuer, "https://elsewhere.example/")).toBe(false);
    expect(policy.allows(issuer, "https://user@link.example/")).toBe(false);
    expect(policy.allows(issuer, cloud + "link/callback?state=wrong&code=code")).toBe(false);
    expect(policy.allows(issuer, cloud + `link/callback?state=${state}&state=${state}`)).toBe(
      false,
    );
    const callback = cloud + `link/callback?state=${state}&code=code`;
    expect(policy.allows(issuer, callback)).toBe(true);
    policy.committed(callback);
    expect(policy.allows(callback, issuer + "/login")).toBe(false);
  });
  test("foreign pages, subframes and malformed authorization cannot open a flow", () => {
    const policy = createCloudWorkbenchNavigation(cloud);
    expect(policy.allows("https://other.example", authorization())).toBe(false);
    expect(policy.allows(cloud, authorization(), false)).toBe(false);
    for (const value of [
      authorization({ redirect_uri: "https://other.example/link/callback" }),
      authorization({ response_type: "token" }),
      authorization({ code_challenge_method: "plain" }),
      authorization({ state: "short" }),
      authorization({ client_id: "" }),
      authorization() + "&redirect_uri=" + encodeURIComponent(cloud + "link/callback"),
      authorization().replace("https:", "http:"),
      authorization() + "#fragment",
    ])
      expect(policy.allows(cloud, value)).toBe(false);
    expect(policy.allows(cloud, issuer + "/login")).toBe(false);
  });
  test("flow expires without extending on same-origin navigation and can be cancelled", () => {
    let time = 0;
    const policy = createCloudWorkbenchNavigation(cloud, () => time);
    expect(policy.allows(cloud, authorization())).toBe(true);
    time = 599_999;
    expect(policy.allows(issuer, issuer + "/login")).toBe(true);
    time = 600_000;
    expect(policy.allows(issuer, authorization())).toBe(false);
    expect(policy.allows(issuer, cloud)).toBe(true);
    expect(policy.allows(cloud, authorization())).toBe(true);
    policy.reset();
    expect(policy.allows(issuer, issuer + "/login")).toBe(false);
  });
});
