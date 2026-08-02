// The chat capability shape and pet's validator must not drift apart.
//
// `ChannelCapabilities.outbound` lives in @cjhyy/code-shell-chat; pet re-declares
// a mirror type and validates against a hard-coded key ALLOWLIST that rejects any
// unknown key outright. So adding a field on the chat side silently invalidates
// every real channel: Mimi loses Gateway discovery on IM turns and the only clue
// is "contains an invalid Gateway capability catalog".
//
// That has now happened twice (`proactive`, then `direct`). Neither package can
// import the other — pet must not depend on a host/product package — so the
// contract cannot be expressed as a shared type. Desktop depends on both, so it
// is the one place the two shapes can actually be compared.
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

  test("an unknown outbound key is still rejected", () => {
    // The allowlist must stay strict — this guard exists so the fix for drift is
    // "teach pet the new field", never "stop validating".
    const rejected = parsePetGatewayCatalog({
      currentChannel: "telegram",
      channels: [
        {
          channel: "telegram",
          capabilities: {
            inbound: { text: true, attachments: [] },
            outbound: {
              text: true,
              button: "link",
              attachments: [],
              somethingNobodyTaughtPetAbout: true,
            },
          },
        },
      ],
    });
    expect(rejected).toBeUndefined();
  });
});
