import { describe, expect, test } from "bun:test";
import type { ToolContext } from "@cjhyy/code-shell-core/extension";
import {
  gatewayAvailability,
  gatewayTool,
  parsePetGatewayCatalog,
  type PetGatewayCatalog,
} from "./gateway.js";

const catalogInput = {
  currentChannel: "teams",
  channels: [
    {
      channel: "teams",
      capabilities: {
        inbound: { text: true, attachments: ["image", "file", "audio", "video"] },
        outbound: {
          text: true,
          maxTextLength: 8_000,
          button: "link",
          attachments: ["image"],
          maxAttachments: 4,
          maxAttachmentBytes: 1024 * 1024,
        },
      },
    },
    {
      channel: "line",
      capabilities: {
        inbound: { text: true, attachments: ["image", "file", "audio", "video"] },
        outbound: {
          text: true,
          maxTextLength: 8_000,
          button: "native",
          attachments: [],
        },
      },
    },
  ],
} as const;

function context(catalog: PetGatewayCatalog): ToolContext {
  return { runScopedServices: { petGateway: catalog } } as unknown as ToolContext;
}

describe("Gateway discovery tool", () => {
  test("searches granted channels before exposing one exact capability contract", async () => {
    const catalog = parsePetGatewayCatalog(catalogInput)!;
    const ctx = context(catalog);

    expect(JSON.parse(await gatewayTool({ action: "search" }, ctx))).toMatchObject({
      currentChannel: "teams",
      matches: [
        { channel: "teams", current: true },
        { channel: "line", current: false },
      ],
    });
    expect(JSON.parse(await gatewayTool({ action: "describe" }, ctx))).toMatchObject({
      current: true,
      channel: "teams",
      capabilities: {
        outbound: {
          button: "link",
          attachments: ["image"],
          maxAttachmentBytes: 1024 * 1024,
        },
      },
      execution: {
        tool: "GatewayReply",
        destination: "current originating IM conversation",
      },
    });
  });

  test("filters compact search results by directional capabilities", async () => {
    const ctx = context(parsePetGatewayCatalog(catalogInput)!);
    expect(
      JSON.parse(await gatewayTool({ action: "search", query: "outbound:image" }, ctx)).matches,
    ).toEqual([{ channel: "teams", current: true }]);
    expect(
      JSON.parse(await gatewayTool({ action: "search", query: "inbound:video button:native" }, ctx))
        .matches,
    ).toEqual([{ channel: "line", current: false }]);
    expect(
      JSON.parse(await gatewayTool({ action: "search", query: "current" }, ctx)).matches,
    ).toEqual([{ channel: "teams", current: true }]);
  });

  test("describes another enabled channel without granting a cross-channel send", async () => {
    const result = JSON.parse(
      await gatewayTool(
        { action: "describe", channel: "line" },
        context(parsePetGatewayCatalog(catalogInput)!),
      ),
    );

    expect(result).toMatchObject({
      current: false,
      channel: "line",
      capabilities: { outbound: { attachments: [] } },
      execution: {
        tool: null,
        reason: expect.stringContaining("current originating conversation"),
      },
    });
  });

  test("fails closed for unknown channels, malformed calls, and missing context", async () => {
    const ctx = context(parsePetGatewayCatalog(catalogInput)!);
    expect(await gatewayTool({ action: "describe", channel: "slack" }, ctx)).toContain(
      "not granted",
    );
    expect(
      JSON.parse(await gatewayTool({ action: "search", query: "channel:slack" }, ctx)).matches,
    ).toEqual([]);
    expect(await gatewayTool({ action: "search", channel: "teams" }, ctx)).toContain(
      "does not accept",
    );
    expect(await gatewayTool({ action: "describe", query: "image" }, ctx)).toContain(
      "does not accept",
    );
    expect(await gatewayTool({ action: "describe", extra: true }, ctx)).toContain("accepts only");
    expect(
      await gatewayTool({ action: "search" }, {
        runScopedServices: {},
      } as unknown as ToolContext),
    ).toContain("available only");
  });

  test("validates and freezes the bounded adapter-owned catalog", () => {
    const catalog = parsePetGatewayCatalog(catalogInput);
    expect(catalog).toBeDefined();
    expect(Object.isFrozen(catalog)).toBe(true);
    expect(Object.isFrozen(catalog?.channels)).toBe(true);
    expect(Object.isFrozen(catalog?.channels[0]?.capabilities.outbound.attachments)).toBe(true);
    expect(
      parsePetGatewayCatalog({
        ...catalogInput,
        channels: [catalogInput.channels[0], { ...catalogInput.channels[1], channel: "teams" }],
      }),
    ).toBeUndefined();
    expect(parsePetGatewayCatalog({ ...catalogInput, currentChannel: "slack" })).toBeUndefined();
    expect(
      parsePetGatewayCatalog({
        ...catalogInput,
        channels: [
          {
            ...catalogInput.channels[0],
            capabilities: {
              ...catalogInput.channels[0].capabilities,
              outbound: {
                ...catalogInput.channels[0].capabilities.outbound,
                maxAttachmentBytes: 11 * 1024 * 1024,
              },
            },
          },
        ],
      }),
    ).toBeUndefined();
  });

  test("is visible only when a validated catalog reaches profile metadata", () => {
    expect(
      gatewayAvailability({
        profileMeta: { petGateway: parsePetGatewayCatalog(catalogInput) },
      } as never),
    ).toBe(true);
    expect(gatewayAvailability({ profileMeta: {} } as never)).toBe(false);
  });
});
