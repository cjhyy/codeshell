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

test("each reviewed provider is bound to its own fixed authorization entry and callback", () => {
  const entries: Record<string, string> = {
    github: "https://github.com/login/oauth/authorize",
    gitlab: "https://gitlab.com/oauth/authorize",
    sentry: "https://sentry.io/oauth/authorize/",
    vercel: "https://vercel.com/integrations/codeshell/new",
    slack: "https://slack.com/oauth/v2/authorize",
    notion: "https://api.notion.com/v1/oauth/authorize",
    linear: "https://linear.app/oauth/authorize",
    todoist: "https://app.todoist.com/oauth/authorize",
    airtable: "https://airtable.com/oauth2/v1/authorize",
    figma: "https://www.figma.com/oauth",
  };
  for (const [id, entry] of Object.entries(entries)) {
    const issuer = "https://link.example";
    const callback = "http://localhost:4900/callback";
    const navigate = createNativeLinkNavigationPolicy(
      `${issuer}/oauth/authorize?provider_id=${id}`,
      callback,
    );
    const upstream = `${entry}?${new URLSearchParams({ client_id: "fixture", state: "upstream-state", ...(id === "vercel" ? { redirect_uri: `${issuer}/oauth/upstream/vercel/callback` } : {}) })}`;
    expect(navigate(upstream, false)).toBe("deny");
    const other = id === "github" ? entries.gitlab! : entries.github!;
    expect(navigate(`${other}?client_id=fixture&state=state`, true)).toBe("deny");
    expect(navigate(upstream, true)).toBe("allow");
    expect(navigate(callback, true)).toBe("deny");
    expect(
      navigate(`${issuer}/oauth/upstream/${id === "github" ? "gitlab" : "github"}/callback`, true),
    ).toBe("deny");
    expect(navigate(`${issuer}/oauth/upstream/${id}/callback?code=once`, true)).toBe("allow");
    expect(navigate(callback, true)).toBe("callback");
  }
});

test("unknown or ambiguous provider ids cannot install navigation authority", () => {
  for (const query of ["provider_id=unreviewed", "provider_id=github&provider_id=gitlab"]) {
    const navigate = createNativeLinkNavigationPolicy(
      `https://link.example/oauth/authorize?${query}`,
      "http://localhost:4900/callback",
    );
    expect(navigate("https://link.example/oauth/authorize", true)).toBe("deny");
    expect(navigate(githubAuthorization, true)).toBe("deny");
  }
});
