import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  accountLinksRequest,
  accountLinkView,
  accountLinkRevocation,
  accountGitHubRequest,
} from "./cloud-account-links.js";

const origin = "https://account.example";
const connectionId = randomUUID();
const grantId = randomUUID();
const clientId = randomUUID();
const view = () => ({
  linkOrigin: "https://link.example",
  connections: [
    {
      id: connectionId,
      provider: "github",
      account: { id: "42", login: "test-user" },
      revoked: false,
    },
  ],
  grants: [
    {
      id: grantId,
      connectionId,
      client: { id: clientId, name: "Test desktop" },
      scopes: ["github.get_repository"],
      resources: ["owner/repo"],
      revoked: false,
    },
  ],
});

test("account Link projection strips credentials and global authority at every nesting level", () => {
  const safe = view();
  const raw = {
    ...safe,
    accessToken: "must-not-cross",
    clients: [{ secret: "must-not-cross" }],
    connections: [
      {
        ...safe.connections[0],
        token: "must-not-cross",
        account: { ...safe.connections[0].account, secret: "must-not-cross" },
      },
    ],
    grants: [
      {
        ...safe.grants[0],
        accessToken: "must-not-cross",
        client: { ...safe.grants[0].client, secret: "must-not-cross" },
      },
    ],
  };
  expect(accountLinkView(raw)).toEqual(safe);
  expect(JSON.stringify(accountLinkView(raw))).not.toContain("must-not-cross");
});

test("account Link view rejects partial relationships, duplicates, invalid flags, control characters and capacity overflow", () => {
  const changes = [
    (v: any) => {
      v.grants[0].connectionId = randomUUID();
    },
    (v: any) => {
      v.grants.push(v.grants[0]);
    },
    (v: any) => {
      v.connections.push(v.connections[0]);
    },
    (v: any) => {
      v.connections[0].revoked = "false";
    },
    (v: any) => {
      v.connections[0].account.login = "foo\nbar";
    },
    (v: any) => {
      v.grants[0].client.id = "not-uuid";
    },
    (v: any) => {
      v.grants[0].resources = [{ repository: "owner/repo" }];
    },
    (v: any) => {
      v.grants[0].resources = Array(101).fill("owner/repo");
    },
    (v: any) => {
      v.connections = Array(513).fill(v.connections[0]);
    },
    (v: any) => {
      v.grants = Array(4097).fill(v.grants[0]);
    },
    (v: any) => {
      v.linkOrigin = "https://link.example/another-path";
    },
  ];
  for (const change of changes) {
    const value = view();
    change(value);
    expect(() => accountLinkView(value)).toThrow();
  }
});

test("account management requests carry an exact identity and reject extra mutation fields or arbitrary IDs", () => {
  const list = { origin, accountId: randomUUID(), action: "list" as const };
  expect(accountLinksRequest(list)).toEqual(list);
  for (const value of [
    { ...list, path: "/global/clients" },
    { ...list, action: "delete" },
    { ...list, action: "revoke", kind: "clients", id: grantId },
    { ...list, action: "revoke", kind: "connections", id: "../" },
    { ...list, origin: "https://account.example/path" },
  ])
    expect(() => accountLinksRequest(value)).toThrow();
  const revoke = { ...list, action: "revoke" as const, kind: "grants" as const, id: grantId };
  expect(
    accountLinkRevocation({ revoked: true, kind: "grants", id: grantId, token: "private" }, revoke),
  ).toEqual({ action: "revoke", revoked: true, kind: "grants", id: grantId });
  for (const value of [
    { revoked: false, kind: "grants", id: grantId },
    { revoked: true, kind: "connections", id: grantId },
    { revoked: true, kind: "grants", id: randomUUID() },
  ])
    expect(() => accountLinkRevocation(value, revoke)).toThrow();
});

test("one typed GitHub channel preserves login and link contracts without an arbitrary action dispatcher", () => {
  expect(accountGitHubRequest({ mode: "login", input: { origin, connectGitHub: false } })).toEqual({
    mode: "login",
    input: { origin, connectGitHub: false },
  });
  expect(accountGitHubRequest({ mode: "link" })).toEqual({ mode: "link" });
  for (const value of [
    { origin },
    { mode: "link", origin },
    { mode: "login", input: { origin, token: "private" } },
    { mode: "revoke" },
  ])
    expect(() => accountGitHubRequest(value)).toThrow();
});
