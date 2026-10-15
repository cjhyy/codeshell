import { describe, expect, test } from "bun:test";
import type { LocalLinkProviderView } from "../../preload/types";
import type { MaskedCredentialView } from "./types";
import { mergeLinkDirectoryProviders } from "./linkDirectory";

const provider: LocalLinkProviderView = {
  id: "figma",
  displayName: "Figma",
  category: "design",
  description: { zh: "设计文件", en: "Design files" },
  brandText: "F",
  icon: "figma",
  accent: "neutral",
  connectionMethods: [
    {
      id: "personal-access-token",
      displayName: { zh: "Token", en: "Token" },
      executionRuntime: "local",
      secretLocation: "device",
      authKind: "token",
      availability: "available",
    },
  ],
  actionIds: [],
  tokenLabel: "Token",
  tokenPlaceholder: "",
  actions: [],
};

describe("Link provider directory recovery", () => {
  test("a partial live catalog preserves local methods and replaces matching live descriptors", () => {
    const remote = {
      ...provider,
      connectionMethods: [
        { ...provider.connectionMethods[0]!, availability: "coming-soon" as const },
        {
          id: "mcp",
          displayName: { zh: "MCP", en: "MCP" },
          executionRuntime: "local" as const,
          secretLocation: "device" as const,
          authKind: "oauth" as const,
          availability: "available" as const,
        },
      ],
    };
    const merged = mergeLinkDirectoryProviders([provider], [remote], []);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.connectionMethods.map((method) => method.id)).toEqual([
      "personal-access-token",
      "mcp",
    ]);
    expect(merged[0]!.connectionMethods[0]!.availability).toBe("coming-soon");
    expect(provider.connectionMethods[0]!.availability).toBe("available");
  });

  test("saved accounts recover their provider and method without inventing an authorization mode", () => {
    const saved: MaskedCredentialView = {
      id: "old-connection",
      type: "oauth",
      label: "Saved account",
      hasSecret: true,
      meta: {
        linkProvider: "custom-service",
        linkConnectionMethod: "scoped-login",
        linkExecutionRuntime: "server",
      },
    };
    const recovered = mergeLinkDirectoryProviders([], undefined, [saved]);
    expect(recovered.map((item) => item.id)).toEqual(["custom-service"]);
    expect(recovered[0]!.connectionMethods[0]).toMatchObject({
      id: "scoped-login",
      availability: "coming-soon",
    });
    expect(recovered[0]!.authModes).toBeUndefined();
  });

  test("Host-only API and MCP accounts stay in their channels during snapshot failure", () => {
    const saved = ["remote", "mcp"].map(
      (backend): MaskedCredentialView => ({
        id: backend,
        type: "oauth",
        label: `Saved ${backend}`,
        hasSecret: true,
        meta: {
          linkProvider: "figma",
          linkExecutionBackend: backend as "remote" | "mcp",
          agentExposable: false,
        },
      }),
    );
    const recovered = mergeLinkDirectoryProviders([], [], saved);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]!.id).toBe("figma");
    expect(recovered[0]!.connectionMethods).toEqual([]);
    expect(recovered[0]!.authModes).toBeUndefined();
  });
});
