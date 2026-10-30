import { describe, expect, test } from "bun:test";
import { HOST_MCP_SESSION_META_KEY, hostSessionMeta } from "./mcp-manager.js";

describe("host MCP Session metadata", () => {
  test("host servers receive the calling Session and its parent chain", () => {
    const parents: Record<string, string | null> = { child: "parent", parent: "root", root: null };
    expect(
      hostSessionMeta("host:cua-driver", {
        sessionId: "child",
        subAgentSpawner: { getSessionParentId: (id: string) => parents[id] } as never,
      }),
    ).toEqual({ _meta: { [HOST_MCP_SESSION_META_KEY]: ["child", "parent", "root"] } });
  });

  test("third-party servers and Session-less contexts receive nothing", () => {
    expect(hostSessionMeta("github", { sessionId: "child" })).toEqual({});
    expect(hostSessionMeta("host:cua-driver", {})).toEqual({});
    expect(hostSessionMeta("host:cua-driver", undefined)).toEqual({});
  });

  test("a cyclic, throwing or very deep parent lookup stays bounded", () => {
    expect(
      hostSessionMeta("host:x", {
        sessionId: "a",
        subAgentSpawner: { getSessionParentId: (id: string) => (id === "a" ? "b" : "a") } as never,
      }),
    ).toEqual({ _meta: { [HOST_MCP_SESSION_META_KEY]: ["a", "b"] } });
    expect(
      hostSessionMeta("host:x", {
        sessionId: "a",
        subAgentSpawner: {
          getSessionParentId: () => {
            throw new Error("disk");
          },
        } as never,
      }),
    ).toEqual({ _meta: { [HOST_MCP_SESSION_META_KEY]: ["a"] } });
    let n = 0;
    const deep = hostSessionMeta("host:x", {
      sessionId: "s0",
      subAgentSpawner: { getSessionParentId: () => `s${++n}` } as never,
    });
    expect((deep._meta![HOST_MCP_SESSION_META_KEY] as string[]).length).toBe(8);
  });
});
