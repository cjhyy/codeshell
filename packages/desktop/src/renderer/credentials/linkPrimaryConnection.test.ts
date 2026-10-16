import { describe, expect, test } from "bun:test";
import type { LinkAuthMode, LinkProviderView, MaskedLinkConnection } from "@cjhyy/code-shell-link";
import { selectPrimaryLinkOption, type PrimaryLinkOption } from "./linkPrimaryConnection";

function provider(authModes: LinkAuthMode[] = []): LinkProviderView {
  return {
    id: "figma",
    displayName: "Figma",
    description: { zh: "设计", en: "Design" },
    category: "design",
    brandText: "F",
    icon: "figma",
    accent: "violet",
    connectionMethods: [],
    actionIds: [],
    actions: [],
    tokenLabel: "Token",
    tokenPlaceholder: "",
    authModes,
  };
}

function mode(id: string, methodId = id, preferred = false): LinkAuthMode {
  return { id, methodId, preferred, available: true, kind: "redirect", label: id };
}

function connection(
  id: string,
  authSource: MaskedLinkConnection["authSource"],
  status: MaskedLinkConnection["status"] = "connected",
): MaskedLinkConnection {
  return {
    id,
    providerId: "figma",
    methodId: authSource === "mcp-oauth" ? "mcp" : authSource,
    label: "Same display label",
    runtime: authSource === "remote-link" ? "server" : "local",
    authSource,
    status,
    account: { id: "same-account", label: "Same account", resources: [] },
    capabilityIds: [],
    revision: `revision-${id}`,
    scope: "user",
    editable: true,
  };
}

const remote: PrimaryLinkOption = {
  id: "remote-link",
  methodId: "remote-link",
  available: true,
};
const mcp: PrimaryLinkOption = { id: "mcp-oauth", methodId: "mcp", available: true };
const token: PrimaryLinkOption = {
  id: "method:personal-access-token:new",
  methodId: "personal-access-token",
  available: true,
};

describe("primary Link presentation option", () => {
  test.each([
    { healthy: "remote-link" as const, failed: "mcp-oauth" as const, expected: remote.id },
    { healthy: "mcp-oauth" as const, failed: "remote-link" as const, expected: mcp.id },
  ])("an unhealthy backup cannot displace a healthy $healthy connection", (scenario) => {
    expect(
      selectPrimaryLinkOption({
        provider: provider([mode("mcp-oauth", "mcp", true)]),
        connections: [
          connection("backup", scenario.failed, "expired"),
          connection("primary", scenario.healthy),
        ],
        options: [mcp, remote, token],
      }),
    ).toBe(scenario.expected);
  });

  test.each([
    { source: "remote-link" as const, expected: remote.id },
    { source: "mcp-oauth" as const, expected: mcp.id },
  ])("an unhealthy saved $source connection retains its original reconnect channel", (scenario) => {
    expect(
      selectPrimaryLinkOption({
        provider: provider([mode("token", token.methodId, true)]),
        connections: [connection("saved", scenario.source, "unavailable")],
        options: [token, { ...remote, available: false }, { ...mcp, available: false }],
      }),
    ).toBe(scenario.expected);
  });

  test("a usable local binding precedes a failed remote account and Host default", () => {
    const local = {
      ...token,
      id: "method:personal-access-token:saved-local",
      credentialId: "saved-local",
      usable: true,
      available: false,
    };
    expect(
      selectPrimaryLinkOption({
        provider: provider([mode("mcp-oauth", "mcp", true)]),
        connections: [connection("old-remote", "remote-link", "invalid")],
        options: [remote, mcp, local],
      }),
    ).toBe(local.id);
  });

  test("a saved credential remains manageable before an unrelated new Host default", () => {
    const saved = {
      ...token,
      id: "method:personal-access-token:old",
      credentialId: "old",
      available: false,
    };
    expect(
      selectPrimaryLinkOption({
        provider: provider([mode("mcp-oauth", "mcp", true)]),
        connections: [],
        options: [mcp, saved],
      }),
    ).toBe(saved.id);
  });

  test("the available Host preferred mode is selected by exact method and mode mapping", () => {
    expect(
      selectPrimaryLinkOption({
        provider: provider([mode("token", token.methodId), mode("mcp-oauth", "mcp", true)]),
        connections: [],
        options: [token, remote, mcp],
      }),
    ).toBe(mcp.id);
    expect(
      selectPrimaryLinkOption({
        provider: provider([mode("token", token.methodId, true)]),
        connections: [],
        options: [remote, token],
      }),
    ).toBe(token.id);
  });

  test("several preferred modes retain Host order without sorting any input", () => {
    const host = provider([
      mode("mcp-oauth", "mcp", true),
      mode("remote-link", "remote-link", true),
    ]);
    const options = Object.freeze([remote, mcp, token]);
    const connections = Object.freeze([]);
    Object.freeze(host.authModes);
    expect(selectPrimaryLinkOption({ provider: host, connections, options })).toBe(mcp.id);
    expect(options.map((option) => option.id)).toEqual([remote.id, mcp.id, token.id]);
    expect(host.authModes?.map((option) => option.id)).toEqual([mcp.id, remote.id]);
  });

  test("unavailable or mismatched preferred modes do not manufacture an available option", () => {
    expect(
      selectPrimaryLinkOption({
        provider: provider([
          { ...mode("mcp-oauth", "mcp", true), available: false },
          mode("remote-link", "different-method", true),
          mode("token", token.methodId),
        ]),
        connections: [],
        options: [{ ...mcp, available: false }, remote, token],
      }),
    ).toBe(token.id);
  });

  test("without a mapped Host mode the first available local option is a presentation fallback", () => {
    expect(
      selectPrimaryLinkOption({
        connections: [],
        options: [{ ...remote, available: false }, token, mcp],
      }),
    ).toBe(token.id);
    expect(
      selectPrimaryLinkOption({ connections: [], options: [{ ...remote, available: false }] }),
    ).toBeUndefined();
    expect(selectPrimaryLinkOption({ connections: [], options: [] })).toBeUndefined();
  });

  test("distinct accounts within one channel are preserved and any healthy account keeps it primary", () => {
    const accounts = [
      connection("old", "remote-link", "expired"),
      connection("active", "remote-link"),
      connection("backup", "mcp-oauth", "invalid"),
    ];
    const before = structuredClone(accounts);
    for (const account of accounts) Object.freeze(account);
    Object.freeze(accounts);
    expect(
      selectPrimaryLinkOption({
        provider: provider(),
        connections: accounts,
        options: [mcp, remote],
      }),
    ).toBe(remote.id);
    expect(accounts).toEqual(before);
    expect(accounts.map((account) => account.id)).toEqual(["old", "active", "backup"]);
  });

  test("local accounts match credential IDs independently of identical names and account labels", () => {
    const first = { ...token, id: "method:personal-access-token:first", credentialId: "first" };
    const second = { ...token, id: "method:personal-access-token:second", credentialId: "second" };
    expect(
      selectPrimaryLinkOption({
        connections: [
          connection("first", "manual-token", "expired"),
          connection("second", "manual-token"),
        ],
        options: [first, second],
      }),
    ).toBe(second.id);
  });

  test("several healthy channels retain option order even when account order changes", () => {
    const accounts = [connection("remote", "remote-link"), connection("mcp", "mcp-oauth")];
    const input = { provider: provider(), options: [mcp, remote] };
    expect(selectPrimaryLinkOption({ ...input, connections: accounts })).toBe(mcp.id);
    expect(selectPrimaryLinkOption({ ...input, connections: [...accounts].reverse() })).toBe(
      mcp.id,
    );
  });

  test("a connection belonging to another provider cannot select this provider's channel", () => {
    const foreign = { ...connection("github", "remote-link"), providerId: "github" };
    expect(
      selectPrimaryLinkOption({
        provider: provider([mode("token", token.methodId, true)]),
        connections: [foreign],
        options: [remote, token],
      }),
    ).toBe(token.id);
  });
});
