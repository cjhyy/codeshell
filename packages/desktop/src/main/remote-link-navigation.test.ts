import { expect, test } from "bun:test";
import { createNativeLinkNavigationPolicy } from "./remote-link-navigation.js";

const issuer = "https://link.example";
const callback = "http://127.0.0.1:43827/link/callback";
const githubAuthorization = "https://github.com/login/oauth/authorize?client_id=client&state=state";
const policy = () => createNativeLinkNavigationPolicy(`${issuer}/oauth/authorize`, callback);

test("the Link service and exact top-level host callback remain available", () => {
  const navigate = policy();
  expect(navigate(`${issuer}/login`, true)).toBe("allow");
  expect(navigate(`${callback}?code=code&state=state`, true)).toBe("callback");
  expect(navigate(`${callback}/other?code=code&state=state`, true)).toBe("deny");
  expect(navigate(callback, false)).toBe("deny");
});

test("the fixed GitHub authorization entry permits login and 2FA until its service callback", () => {
  const navigate = policy();
  expect(navigate("https://github.com/login", true)).toBe("deny");
  expect(navigate(githubAuthorization, true)).toBe("allow");
  expect(navigate("https://github.com/login", true)).toBe("allow");
  expect(navigate("https://github.com/sessions/two-factor", true)).toBe("allow");
  expect(navigate("https://elsewhere.example/login", true)).toBe("deny");
  expect(navigate(`${issuer}/`, true)).toBe("deny");
  expect(navigate(callback, true)).toBe("deny");
  expect(navigate(`${issuer}/oauth/upstream/github/callback?code=code&state=state`, true)).toBe(
    "allow",
  );
  expect(navigate(`${issuer}/oauth/authorize?resume=consent`, true)).toBe("allow");
  expect(navigate("https://github.com/login", true)).toBe("deny");
  expect(navigate(`${callback}?code=code&state=state`, true)).toBe("callback");
});

test("GitHub authorization requires an exact secure origin and unambiguous client and state", () => {
  for (const target of [
    "https://github.com/login/oauth/authorize?state=state",
    "https://github.com/login/oauth/authorize?client_id=client",
    "https://github.com/login/oauth/authorize?client_id=client&state=",
    "https://github.com/login/oauth/authorize?client_id=&state=state",
    "https://github.com/login/oauth/authorize?client_id=client&state=one&state=two",
    "https://github.com/login/oauth/authorize?client_id=one&client_id=two&state=state",
    "https://github.com/login/oauth/authorize?client_id=client&state=state#fragment",
    "http://github.com/login/oauth/authorize?client_id=client&state=state",
    "https://github.com.evil.example/login/oauth/authorize?client_id=client&state=state",
    "https://github.com:8443/login/oauth/authorize?client_id=client&state=state",
    "https://user:password@github.com/login/oauth/authorize?client_id=client&state=state",
    "javascript:alert(1)",
    "not a URL",
  ]) {
    const navigate = policy();
    expect(navigate(target, true)).toBe("deny");
    expect(navigate("https://github.com/login", true)).toBe("deny");
  }
});

test("subframes cannot start or inherit a GitHub login or complete either callback", () => {
  const navigate = policy();
  expect(navigate(githubAuthorization, false)).toBe("deny");
  expect(navigate("https://github.com/login", true)).toBe("deny");
  expect(navigate(githubAuthorization, true)).toBe("allow");
  expect(navigate("https://github.com/login", false)).toBe("deny");
  expect(navigate(`${issuer}/oauth/upstream/github/callback`, false)).toBe("deny");
  expect(navigate(callback, false)).toBe("deny");
  expect(navigate("https://github.com/sessions/two-factor", true)).toBe("allow");
});
