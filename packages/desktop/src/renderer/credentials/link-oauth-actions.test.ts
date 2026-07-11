import { describe, expect, test } from "bun:test";
import type { MaskedCredentialView } from "./types";
import { linkOAuthPrimaryAction } from "./link-oauth-actions";

function credential(
  state: NonNullable<MaskedCredentialView["oauthStatus"]>["state"],
  lastRefreshErrorCode?: NonNullable<MaskedCredentialView["meta"]>["lastRefreshErrorCode"],
): MaskedCredentialView {
  return {
    id: "figma-oauth",
    type: "oauth",
    label: "Figma OAuth",
    hasSecret: true,
    oauthStatus: { state },
    meta: { oauthProvider: "figma", lastRefreshErrorCode },
  };
}

describe("linkOAuthPrimaryAction", () => {
  test("uses the real login flow to recover an invalid_grant credential", () => {
    expect(linkOAuthPrimaryAction(credential("expired", "invalid_grant"), true)).toBe("login");
  });

  test("keeps ordinary expired credentials on the refresh flow", () => {
    expect(linkOAuthPrimaryAction(credential("expired"), true)).toBe("refresh");
  });

  test("does not offer a login flow for an unaudited catalog integration", () => {
    expect(linkOAuthPrimaryAction(credential("invalid", "invalid_grant"), false)).toBe("refresh");
    expect(linkOAuthPrimaryAction(undefined, false)).toBe("unsupported");
  });
});
