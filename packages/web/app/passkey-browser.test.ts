import { expect, test } from "bun:test";
import {
  authenticationOptions,
  registrationOptions,
  parsePasskeyCeremony,
  parsePasskeyProof,
} from "./passkey-browser.js";
import { desktopRemoteAccessRequest, parseDesktopRemoteAccess } from "./DesktopRemoteAccess.js";
import { parsePasskeys } from "./PasskeySettings.js";

const host = "codeshell.site",
  opaque = "Q".repeat(43);
test("authentication and registration require this exact site and explicit user verification", () => {
  const authentication = { rpId: host, challenge: opaque, userVerification: "required" };
  expect(authenticationOptions(authentication, host).userVerification).toBe("required");
  for (const change of [
    { userVerification: "preferred" },
    { userVerification: undefined },
    { rpId: "site" },
    { rpId: "other.codeshell.site" },
    { challenge: "short" },
  ])
    expect(() => authenticationOptions({ ...authentication, ...change }, host)).toThrow();
  const registration = {
    rp: { id: host },
    challenge: opaque,
    user: { id: "c29tZS1hY2NvdW50", name: "member", displayName: "Member" },
    authenticatorSelection: { userVerification: "required" },
  };
  expect(registrationOptions(registration, host).authenticatorSelection?.userVerification).toBe(
    "required",
  );
  expect(() =>
    registrationOptions(
      { ...registration, authenticatorSelection: { userVerification: "preferred" } },
      host,
    ),
  ).toThrow();
  expect(() =>
    registrationOptions({ ...registration, rp: { id: "elsewhere.example" } }, host),
  ).toThrow();
});
test("proof and ceremony responses reject malformed or unbounded credentials", () => {
  expect(parsePasskeyCeremony({ ceremonyId: opaque, optionsJSON: {} }).ceremonyId).toBe(opaque);
  expect(() => parsePasskeyCeremony({ ceremonyId: "short", optionsJSON: {} })).toThrow();
  expect(
    parsePasskeyProof({ stepUpToken: opaque, expiresAt: Date.now() + 60000 }).stepUpToken,
  ).toBe(opaque);
  for (const expiresAt of [0, Date.now() - 1, Date.now() + 86400000, Infinity])
    expect(() => parsePasskeyProof({ stepUpToken: opaque, expiresAt })).toThrow();
});
test("native remote authorization accepts only a fixed request route and complete target identity", () => {
  expect(
    desktopRemoteAccessRequest(
      new URL(`/remote-access?request=${opaque}`, "https://codeshell.site"),
    ),
  ).toBe(opaque);
  for (const suffix of ["&request=" + opaque, "&callback=https://outside.example", "#secret"])
    expect(
      desktopRemoteAccessRequest(
        new URL(`/remote-access?request=${opaque}${suffix}`, "https://codeshell.site"),
      ),
    ).toBeUndefined();
  const target = {
    hostId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    environmentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    name: "Home computer",
  };
  expect(
    parseDesktopRemoteAccess({ deviceName: "Laptop", target, expiresAt: Date.now() + 60000 })
      .target,
  ).toEqual(target);
  expect(() =>
    parseDesktopRemoteAccess({
      deviceName: "Laptop",
      target: { ...target, environmentId: "invalid" },
      expiresAt: Date.now() + 60000,
    }),
  ).toThrow();
  expect(() =>
    parseDesktopRemoteAccess({ deviceName: "Laptop", target, expiresAt: Date.now() + 86400000 }),
  ).toThrow();
});
test("Passkey settings require a coherent list and explicit bootstrap capabilities", () => {
  const entry = { id: opaque, name: "My passkey", createdAt: Date.now() };
  const valid = { passkeys: [entry], bootstrap: { password: true, github: false } };
  expect(parsePasskeys(valid).passkeys).toEqual([entry]);
  expect(() => parsePasskeys({ ...valid, passkeys: [entry, entry] })).toThrow();
  expect(() => parsePasskeys({ ...valid, bootstrap: {} })).toThrow();
  expect(() => parsePasskeys({ ...valid, passkeys: [{ ...entry, id: "../another" }] })).toThrow();
});
