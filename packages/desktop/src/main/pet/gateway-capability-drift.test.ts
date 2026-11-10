// The chat capability shape and pet's validator must not drift apart.
//
// `ChannelCapabilities.outbound` lives in @cjhyy/code-shell-chat; pet re-declares
// a mirror type and validates against a hard-coded key ALLOWLIST. It used to
// reject any unknown key outright, so adding a field on the chat side silently
// invalidated every real channel: Mimi lost Gateway discovery on IM turns and the
// only clue was "contains an invalid Gateway capability catalog". That happened
// twice (`proactive`, then `direct`). Unknown BOOLEAN flags are now ignored, and
// host-side flags such as `idempotentSend` are stripped before the wire; unknown
// keys of any other shape are still rejected.
//
// Neither package can import the other — pet must not depend on a host/product
// package — so the contract cannot be expressed as a shared type. Desktop
// depends on both, so it is the one place the two shapes can actually be compared.
//
// This is a CONTRACT test, not a unit test: it feeds the REAL builtin channel
// capabilities through the REAL validator. Adding a field to chat without
// teaching pet about it fails here instead of in production.
import { describe, expect, test } from "bun:test";
import { BUILTIN_CHANNEL_CAPABILITIES } from "@cjhyy/code-shell-chat";
import { parsePetGatewayCatalog } from "@cjhyy/code-shell-pet";

describe("chat ↔ pet gateway capability contract", () => {
  test("every builtin channel's capabilities pass pet catalog validation", () => {
    const failed = Object.entries(BUILTIN_CHANNEL_CAPABILITIES)
      .filter(
        ([channel, capabilities]) =>
          !parsePetGatewayCatalog({
            currentChannel: channel,
            channels: [{ channel, capabilities }],
          }),
      )
      // Report the outbound keys: the culprit is almost always a newly added
      // field that pet's allowlist has not been told about.
      .map(
        ([channel, capabilities]) =>
          `${channel} (outbound keys: ${Object.keys(
            (capabilities as { outbound: Record<string, unknown> }).outbound,
          ).join(", ")})`,
      );

    expect(failed).toEqual([]);
  });

  test("a multi-channel catalog of every builtin channel validates as one unit", () => {
    // The real runtime shape: the current channel plus the full discovery list.
    const channels = Object.entries(BUILTIN_CHANNEL_CAPABILITIES).map(
      ([channel, capabilities]) => ({ channel, capabilities }),
    );
    const first = channels[0];
    expect(first).toBeDefined();

    const catalog = parsePetGatewayCatalog({
      currentChannel: first!.channel,
      channels,
    });
    expect(catalog).toBeDefined();
    expect(catalog!.channels).toHaveLength(channels.length);
  });

  test("an unknown non-boolean outbound key is still rejected", () => {
    // The allowlist stays strict for value shapes — only additive boolean flags
    // are tolerated, never "stop validating".
    const withOutbound = (extra: Record<string, unknown>) =>
      parsePetGatewayCatalog({
        currentChannel: "telegram",
        channels: [
          {
            channel: "telegram",
            capabilities: {
              inbound: { text: true, attachments: [] },
              outbound: { text: true, button: "link", attachments: [], ...extra },
            },
          },
        ],
      });
    expect(withOutbound({ somethingNobodyTaughtPetAbout: "yes" })).toBeUndefined();
    expect(withOutbound({ somethingNobodyTaughtPetAbout: 1 })).toBeUndefined();
    const tolerated = withOutbound({ somethingNobodyTaughtPetAbout: true });
    expect(tolerated).toBeDefined();
    expect(tolerated!.channels[0]!.capabilities.outbound).not.toHaveProperty(
      "somethingNobodyTaughtPetAbout",
    );
  });
});
