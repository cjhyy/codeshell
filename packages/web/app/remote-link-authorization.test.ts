import { expect, test } from "bun:test";
import {
  rememberRemoteLink,
  remoteLinkAuthorizationUrl,
  takeLinkCallback,
} from "./remote-link-authorization.js";
const origin = "https://hub.example",
  issuer = "https://link.example";
const id = "11111111-1111-4111-8111-111111111111",
  projectId = "22222222-2222-4222-8222-222222222222";
function fixture() {
  let value: string | null = null;
  const storage = {
    getItem: () => value,
    setItem: (_key: string, next: string) => {
      value = next;
    },
    removeItem: () => {
      value = null;
    },
  };
  const params = new URLSearchParams({
    state: "private-attempt-state",
    redirect_uri: origin + "/link/callback",
    client_id: "public-client",
  });
  const job = {
    id,
    providerId: "github",
    state: "pending" as const,
    redirect: {
      authorizationUrl: issuer + "/oauth/authorize?" + params,
      expiresAt: new Date(Date.now() + 600000).toISOString(),
    },
  };
  let clean = "";
  const history = {
    state: null,
    replaceState: (_state: unknown, _unused: string, url?: string | URL | null) => {
      clean = String(url);
    },
  };
  const location = {
    origin,
    pathname: "/link/callback",
    href: origin + "/link/callback?state=private-attempt-state&code=private-one-use-code",
  };
  return {
    storage,
    job,
    history,
    location,
    get clean() {
      return clean;
    },
  };
}
test("authorization stores only routing state and callback preserves the originating project", () => {
  const f = fixture();
  expect(rememberRemoteLink(f.job, issuer, { workspace: "", projectId }, origin, f.storage)).toBe(
    f.job.redirect.authorizationUrl,
  );
  const stored = f.storage.getItem()!;
  expect(stored).not.toContain("code_verifier");
  expect(stored).not.toContain("private-one-use-code");
  const result = takeLinkCallback(f.location, f.history, f.storage)!;
  expect(result).not.toHaveProperty("error");
  if (!("error" in result)) {
    expect(result.pending.target).toBe(`/p/${projectId}/api/v1/links/authorizations/${id}`);
    expect(result.pending.returnUrl).toContain(`project=${projectId}`);
  }
  expect(f.clean).toBe("/link/callback");
  expect(f.storage.getItem()).toBeNull();
  expect(takeLinkCallback(f.location, f.history, f.storage)).toHaveProperty("error");
});
test("unmatched state, expiry and foreign routing cannot turn a callback into a write", () => {
  for (const mode of ["state", "expiry", "target", "return"]) {
    const f = fixture();
    rememberRemoteLink(
      f.job,
      issuer,
      { workspace: "/original", projectId: null },
      origin,
      f.storage,
    );
    const pending = JSON.parse(f.storage.getItem()!);
    if (mode === "state") f.location.href += "&state=another";
    if (mode === "expiry") pending.expiresAt = 0;
    if (mode === "target") pending.target = "https://elsewhere/api/v1/links/authorizations/" + id;
    if (mode === "return") pending.returnUrl = "//elsewhere";
    f.storage.setItem("", JSON.stringify(pending));
    expect(takeLinkCallback(f.location, f.history, f.storage)).toHaveProperty("error");
    expect(f.clean).toBe("/link/callback");
  }
});
test("provider denial retains routing but does not become a token exchange", () => {
  const f = fixture();
  rememberRemoteLink(f.job, issuer, { workspace: "", projectId: null }, origin, f.storage);
  f.location.href = origin + "/link/callback?state=private-attempt-state&error=access_denied";
  expect(takeLinkCallback(f.location, f.history, f.storage)).toMatchObject({ denied: true });
});
test("only the configured HTTPS or development loopback authorization page can open", () => {
  for (const bad of [
    "javascript:alert(1)",
    "https://elsewhere/oauth/authorize",
    issuer + "/other",
    "http://link.example/oauth/authorize",
    "https://user:secret@link.example/oauth/authorize",
  ]) {
    expect(() => remoteLinkAuthorizationUrl(bad, issuer)).toThrow();
  }
  expect(
    remoteLinkAuthorizationUrl("http://127.0.0.1:4000/oauth/authorize", "http://127.0.0.1:4000")
      .protocol,
  ).toBe("http:");
  const f = fixture();
  expect(() =>
    rememberRemoteLink(
      f.job,
      issuer,
      { workspace: "", projectId: null },
      "https://other.example",
      f.storage,
    ),
  ).toThrow("回调");
});
