import { expect, test } from "bun:test";
import type { LinkProviderView } from "@cjhyy/code-shell-link";
import { accountLinkMethods } from "./account-link-methods.js";

const provider = {
  id: "fixture",
  connectionMethods: [
    { id: "local", executionRuntime: "local", availability: "available" },
    { id: "remote", executionRuntime: "server", availability: "available" },
  ],
  authModes: [
    { methodId: "local", available: true },
    { methodId: "remote", available: true },
  ],
} as LinkProviderView;

test("unavailable account features never remove or disable local Link methods", () => {
  for (const state of ["hidden", "sign-in", "pending"] as const) {
    const view = accountLinkMethods(provider, { id: "links.remote", state });
    expect(view.connectionMethods.find((method) => method.id === "local")).toBe(
      provider.connectionMethods[0],
    );
    expect(view.authModes?.find((mode) => mode.methodId === "local")?.available).toBe(true);
    const remote = view.authModes?.find((mode) => mode.methodId === "remote");
    if (state === "hidden") expect(remote).toBeUndefined();
    else {
      expect(remote?.available).toBe(false);
      expect(remote?.unavailableReason).toContain(state === "sign-in" ? "登录后" : "重试");
    }
  }
  expect(provider.authModes?.[1]?.available).toBe(true);
});

test("standalone Hub and ready Account preserve the host's offered Link methods", () => {
  expect(accountLinkMethods(provider, null)).toBe(provider);
  expect(accountLinkMethods(provider, { id: "links.remote", state: "ready" })).toBe(provider);
});
