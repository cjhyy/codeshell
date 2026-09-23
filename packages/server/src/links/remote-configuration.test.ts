import { expect, test } from "bun:test";
import { remoteLinkFromEnvironment, remoteLinkHostConfiguration } from "./remote-configuration.js";
import { parseServeArgs } from "../serve/cli.js";
const env = {
  CODE_SHELL_REMOTE_LINK_ISSUER: "https://link.example/",
  CODE_SHELL_REMOTE_LINK_CLIENT_ID: "public-client",
  CODE_SHELL_REMOTE_LINK_CLIENT_SECRET: "private-fixture",
};
test("deployment configuration is optional, normalized and bound to the public callback", () => {
  expect(remoteLinkFromEnvironment({}, undefined)).toBeUndefined();
  const config = remoteLinkFromEnvironment(env, "https://hub.example")!;
  expect(config).toEqual({
    issuer: "https://link.example",
    clientId: "public-client",
    clientSecret: "private-fixture",
    redirectUri: "https://hub.example/link/callback",
  });
  expect(Object.isFrozen(config)).toBe(true);
  expect(
    parseServeArgs(["--runtime", "docker", "--public-url", "https://hub.example"], env).remoteLink,
  ).toEqual(config);
  expect(() =>
    parseServeArgs(["--auth", "passcode", "--public-url", "https://hub.example"], env),
  ).toThrow("requires --auth hub");
});
test("partial, insecure or cross-host configuration fails without printing supplied secrets", () => {
  for (const candidate of [
    { env, origin: undefined },
    { env: { ...env, CODE_SHELL_REMOTE_LINK_CLIENT_ID: "" }, origin: "https://hub.example" },
    {
      env: { ...env, CODE_SHELL_REMOTE_LINK_ISSUER: "http://private-fixture@elsewhere/path" },
      origin: "https://hub.example",
    },
  ]) {
    let message = "";
    try {
      remoteLinkFromEnvironment(candidate.env, candidate.origin);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("Remote Link requires");
    expect(message).not.toContain("private-fixture");
  }
  expect(() =>
    remoteLinkHostConfiguration(
      {
        issuer: "https://link.example",
        clientId: "id",
        redirectUri: "https://elsewhere/link/callback",
      },
      "https://hub.example",
    ),
  ).toThrow("Remote Link requires");
});
