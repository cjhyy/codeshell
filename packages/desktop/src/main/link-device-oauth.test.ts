import { describe, expect, test } from "bun:test";
import { LinkDeviceOAuthBroker } from "./link-device-oauth.js";

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("local Link browser OAuth", () => {
  test("reports whether the release configured its public provider client id", () => {
    const broker = new LinkDeviceOAuthBroker({ environment: {} });
    expect(broker.status("github")).toEqual({
      providerId: "github",
      configured: false,
      flow: "device-code",
      configurationCode: "client_id_missing",
    });
  });

  test("completes GitHub device login without exposing the token in the prompt", async () => {
    const requests: Array<{ url: string; body: string }> = [];
    const responses = [
      jsonResponse({
        device_code: "private-device-code",
        user_code: "ABCD-EFGH",
        verification_uri: "https://github.com/login/device",
        expires_in: 900,
        interval: 5,
      }),
      jsonResponse({ error: "authorization_pending" }),
      jsonResponse({
        access_token: "ghu_private_access",
        refresh_token: "ghr_private_refresh",
        expires_in: 28_800,
        refresh_token_expires_in: 15_897_600,
        token_type: "bearer",
        scope: "",
      }),
    ];
    const broker = new LinkDeviceOAuthBroker({
      clientIds: { github: "Iv1.public-client" },
      createId: () => "attempt-1",
      now: () => 1_000,
      sleep: async () => undefined,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push({ url: request.url, body: await request.text() });
        return responses.shift()!;
      },
    });

    const prompt = await broker.start("github");
    expect(prompt).toEqual({
      attemptId: "attempt-1",
      providerId: "github",
      userCode: "ABCD-EFGH",
      verificationUri: "https://github.com/login/device",
      verificationUriComplete: undefined,
      expiresAt: new Date(901_000).toISOString(),
    });
    expect(JSON.stringify(prompt)).not.toContain("private-device-code");

    const token = await broker.complete(prompt.attemptId);
    expect(token).toEqual({
      providerId: "github",
      accessToken: "ghu_private_access",
      refreshToken: "ghr_private_refresh",
      expiresIn: 28_800,
      refreshTokenExpiresIn: 15_897_600,
      clientId: "Iv1.public-client",
      tokenEndpoint: "https://github.com/login/oauth/access_token",
      tokenType: "Bearer",
      scope: "",
    });
    expect(requests[0]).toEqual({
      url: "https://github.com/login/device/code",
      body: "client_id=Iv1.public-client",
    });
    expect(requests[1]?.body).toContain("device_code=private-device-code");
    expect(requests[1]?.body).toContain(
      "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code",
    );
  });

  test("supports GitLab pending responses and a pre-filled verification URL", async () => {
    const requests: Array<{ url: string; body: string }> = [];
    const responses = [
      jsonResponse({
        device_code: "gitlab-device",
        user_code: "0A44L90H",
        verification_uri: "https://gitlab.com/oauth/device",
        verification_uri_complete: "https://gitlab.com/oauth/device?user_code=0A44L90H",
        expires_in: 300,
        interval: 5,
      }),
      jsonResponse({ error: "authorization_pending" }, 400),
      jsonResponse({
        access_token: "gitlab-access",
        token_type: "Bearer",
        expires_in: 7200,
        scope: "read_api",
      }),
    ];
    const broker = new LinkDeviceOAuthBroker({
      clientIds: { gitlab: "gitlab-public-client" },
      createId: () => "attempt-gitlab",
      now: () => 5_000,
      sleep: async () => undefined,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push({ url: request.url, body: await request.text() });
        return responses.shift()!;
      },
    });

    const prompt = await broker.start("gitlab");
    expect(prompt.verificationUriComplete).toBe(
      "https://gitlab.com/oauth/device?user_code=0A44L90H",
    );
    expect((await broker.complete(prompt.attemptId)).accessToken).toBe("gitlab-access");
    expect(requests[0]).toEqual({
      url: "https://gitlab.com/oauth/authorize_device",
      body: "client_id=gitlab-public-client&scope=read_api",
    });
  });

  test("rejects a provider response that redirects the user to an untrusted host", async () => {
    const broker = new LinkDeviceOAuthBroker({
      clientIds: { github: "Iv1.public-client" },
      fetch: async () =>
        jsonResponse({
          device_code: "device",
          user_code: "ABCD-EFGH",
          verification_uri: "https://attacker.example/login",
          expires_in: 900,
          interval: 5,
        }),
    });
    await expect(broker.start("github")).rejects.toThrow("untrusted verification_uri");
  });
});
