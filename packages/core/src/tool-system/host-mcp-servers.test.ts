import { describe, expect, test } from "bun:test";
import {
  HOST_MCP_SERVERS_ENV,
  encodeHostMcpServers,
  readHostMcpServers,
  withHostMcpServers,
} from "./host-mcp-servers.js";

function env(value: string | undefined): NodeJS.ProcessEnv {
  return value === undefined ? {} : { [HOST_MCP_SERVERS_ENV]: value };
}

describe("host-owned MCP servers", () => {
  test("round-trips a stdio declaration with the host: prefix", () => {
    const encoded = encodeHostMcpServers({
      "host:cua-driver": {
        command: "/opt/cua-driver",
        args: ["mcp", "--embedded", "--socket", "/tmp/s.sock"],
        env: { CUA_DRIVER_EMBEDDED: "1" },
        inlineImages: true,
      },
    });
    const servers = readHostMcpServers(env(encoded));
    expect(servers["host:cua-driver"]?.command).toBe("/opt/cua-driver");
    expect(servers["host:cua-driver"]?.transport).toBe("stdio");
    expect(servers["host:cua-driver"]?.inlineImages).toBe(true);
    expect(servers["host:cua-driver"]?.env?.CUA_DRIVER_EMBEDDED).toBe("1");
  });

  test("encode rejects names without the host: prefix", () => {
    expect(() => encodeHostMcpServers({ cua: { command: "x" } })).toThrow();
  });

  test("malformed or partially invalid input yields no servers", () => {
    expect(readHostMcpServers(env(undefined))).toEqual({});
    expect(readHostMcpServers(env("not json"))).toEqual({});
    expect(readHostMcpServers(env("[]"))).toEqual({});
    const mixed = JSON.stringify({
      "host:ok": { command: "ok" },
      "host:bad": { command: "bad", url: 1, args: [1] },
    });
    expect(readHostMcpServers(env(mixed))).toEqual({});
    expect(readHostMcpServers(env(JSON.stringify({ plain: { command: "x" } })))).toEqual({});
  });

  test("never forwards URL or credential fields", () => {
    const raw = JSON.stringify({
      "host:x": { command: "x", url: "https://evil.invalid", credentialRef: "secret" },
    });
    const server = readHostMcpServers(env(raw))["host:x"] as Record<string, unknown>;
    expect(server.url).toBeUndefined();
    expect(server.credentialRef).toBeUndefined();
  });

  test("existing names win over host declarations", () => {
    const raw = encodeHostMcpServers({ "host:cua-driver": { command: "host" } });
    const merged = withHostMcpServers(
      { "host:cua-driver": { name: "host:cua-driver", command: "user" } },
      env(raw),
    );
    expect(merged["host:cua-driver"]?.command).toBe("user");
  });
});
