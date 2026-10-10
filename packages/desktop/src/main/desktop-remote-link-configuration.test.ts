import { expect, test } from "bun:test";
import {
  desktopRemoteLinkEnvironment,
  packagedRemoteLinkEnvironment,
} from "./desktop-remote-link-configuration";

test("packaged Desktop includes its public Link deployment without provider credentials", () => {
  const config = desktopRemoteLinkEnvironment({}, true);
  expect(config).toEqual({
    CODE_SHELL_REMOTE_LINK_ISSUER: "https://115.159.45.55:8443",
    CODE_SHELL_REMOTE_LINK_CLIENT_ID: "3c81a13d-8c0b-4e9e-b0ab-13b80e3cf3f9",
    CODE_SHELL_REMOTE_LINK_DESKTOP_ORIGIN: "http://127.0.0.1:43827",
  });
  expect(Object.isFrozen(config)).toBe(true);
  expect(config).not.toHaveProperty("CODE_SHELL_REMOTE_LINK_CLIENT_SECRET");
});

test("development remains unconfigured and explicit disable wins in packaged Desktop", () => {
  expect(desktopRemoteLinkEnvironment({}, false)).toEqual({});
  expect(
    desktopRemoteLinkEnvironment({ CODE_SHELL_REMOTE_LINK_DISABLED: "1" }, true),
  ).toBeUndefined();
  expect(
    desktopRemoteLinkEnvironment(
      { ...packagedRemoteLinkEnvironment, CODE_SHELL_REMOTE_LINK_DISABLED: "1" },
      true,
    ),
  ).toBeUndefined();
});

test("partial, empty or private overrides never inherit public deployment fields", () => {
  for (const custom of [
    { CODE_SHELL_REMOTE_LINK_ISSUER: "https://private-link.example" },
    { CODE_SHELL_REMOTE_LINK_CLIENT_ID: "" },
    { CODE_SHELL_REMOTE_LINK_CLIENT_SECRET: "synthetic-private-client" },
    { CODE_SHELL_REMOTE_LINK_DESKTOP_ORIGIN: "http://127.0.0.1:4900" },
  ]) {
    expect(desktopRemoteLinkEnvironment(custom, true)).toBe(custom);
    expect(Object.keys(custom)).toHaveLength(1);
  }
});
