import { describe, expect, test } from "bun:test";
import { PET_BEHAVIOR_PROFILE } from "./profile.js";
import { petRunOptionsFrom, validatePetRunParams } from "./run-params.js";

describe("validatePetRunParams", () => {
  test("does not claim behavior modes or session kinds owned by other extensions", () => {
    expect(validatePetRunParams({ behaviorMode: "review", kind: "review-session" })).toBeNull();
  });

  test("validates canonical profile params using Engine's override precedence", () => {
    expect(
      validatePetRunParams({
        behaviorMode: "pet",
        kind: "pet",
        petRuntimeContext: '{"legacy":true}',
        profileParams: { runtimeContext: "not-json" },
      }),
    ).toBe("profileParams.runtimeContext must be valid JSON");

    expect(
      validatePetRunParams({
        behaviorMode: "pet",
        kind: "pet",
        profileParams: {
          runtimeContext: '{"pending":[]}',
          workspaces: [{ id: "workspace-a", name: "Alpha" }],
        },
      }),
    ).toBeNull();
  });

  test("rejects malformed canonical workspaces", () => {
    expect(
      validatePetRunParams({
        behaviorMode: "pet",
        kind: "pet",
        profileParams: {
          workspaces: [
            { id: "duplicate", name: "One" },
            { id: "duplicate", name: "Two" },
          ],
        },
      }),
    ).toBe("profileParams.workspaces contains an invalid or duplicate Workspace");
  });

  test("rejects malformed canonical reusable Sessions", () => {
    expect(
      validatePetRunParams({
        behaviorMode: "pet",
        kind: "pet",
        profileParams: {
          reusableSessions: [
            { id: "duplicate", workspaceId: "workspace-a", name: "One" },
            { id: "duplicate", workspaceId: "workspace-a", name: "Two" },
          ],
        },
      }),
    ).toBe("profileParams.reusableSessions contains an invalid or duplicate reusable Session");
  });

  test("rejects reusable Sessions outside the closed Workspace set", () => {
    expect(
      validatePetRunParams({
        behaviorMode: "pet",
        kind: "pet",
        profileParams: {
          workspaces: [{ id: "workspace-a", name: "Alpha" }],
          reusableSessions: [
            { id: "session-b", workspaceId: "workspace-b", name: "Wrong workspace" },
          ],
        },
      }),
    ).toBe("profileParams.reusableSessions contains a Session outside the closed Workspace set");
  });

  test("rejects contradictory Pet identity and leading/trailing opaque ids", () => {
    expect(validatePetRunParams({ behaviorMode: "pet", kind: "work" })).toBe(
      "behaviorMode=pet requires kind=pet",
    );
    expect(
      validatePetRunParams({
        behaviorMode: "pet",
        kind: "pet",
        profileParams: { workspaces: [{ id: " workspace-a ", name: "Alpha" }] },
      }),
    ).toBe("profileParams.workspaces contains an invalid or duplicate Workspace");
  });

  test("rejects malformed or duplicate host-action capability declarations", () => {
    expect(
      validatePetRunParams({
        behaviorMode: "pet",
        kind: "pet",
        profileParams: { hostActions: ["mobileRemote", "memory"] },
      }),
    ).toBeNull();
    expect(
      validatePetRunParams({
        behaviorMode: "pet",
        kind: "pet",
        profileParams: { hostActions: ["mobileRemote", "mobileRemote"] },
      }),
    ).toBe("profileParams.hostActions contains an invalid or duplicate host-action kind");
    expect(
      validatePetRunParams({
        behaviorMode: "pet",
        kind: "pet",
        profileParams: { hostActions: ["shell"] },
      }),
    ).toBe("profileParams.hostActions contains an invalid or duplicate host-action kind");
  });

  test("accepts only a bounded GatewayReply route paired with its host action", () => {
    const gatewayReply = {
      button: "native",
      attachments: ["image", "file", "audio", "video"],
      maxTextLength: 8_000,
      maxAttachments: 4,
      maxAttachmentBytes: 10 * 1024 * 1024,
    };
    expect(
      validatePetRunParams({
        behaviorMode: "pet",
        kind: "pet",
        profileParams: { hostActions: ["gatewayReply"], gatewayReply },
      }),
    ).toBeNull();
    expect(
      validatePetRunParams({
        behaviorMode: "pet",
        kind: "pet",
        profileParams: { hostActions: ["gatewayReply"] },
      }),
    ).toBe("the gatewayReply host action requires profileParams.gatewayReply");
    expect(
      validatePetRunParams({
        behaviorMode: "pet",
        kind: "pet",
        profileParams: { gatewayReply },
      }),
    ).toBe("profileParams.gatewayReply requires the gatewayReply host action");
    expect(
      validatePetRunParams({
        behaviorMode: "pet",
        kind: "pet",
        profileParams: {
          hostActions: ["gatewayReply"],
          gatewayReply: { ...gatewayReply, attachments: ["archive"] },
        },
      }),
    ).toBe("profileParams.gatewayReply contains an invalid Gateway route capability");
  });

  test("accepts only a bounded Gateway discovery catalog containing the current channel", () => {
    const gateway = {
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
    };
    expect(
      validatePetRunParams({
        behaviorMode: "pet",
        kind: "pet",
        profileParams: { gateway },
      }),
    ).toBeNull();
    expect(
      validatePetRunParams({
        behaviorMode: "pet",
        kind: "pet",
        profileParams: { gateway: { ...gateway, currentChannel: "slack" } },
      }),
    ).toBe("profileParams.gateway contains an invalid Gateway capability catalog");
  });
});

describe("Pet behavior profile inputs", () => {
  test("normalizes and freezes valid direct Engine-hosted profile params", () => {
    const options = petRunOptionsFrom({
      workspaces: [
        {
          id: "workspace-a",
          name: " Alpha\nWorkspace ",
          description: " first line\nsecond line ",
        },
      ],
    });

    expect(options).toEqual({
      workspaces: [
        {
          id: "workspace-a",
          name: "Alpha Workspace",
          description: "first line second line",
        },
      ],
      reusableSessions: [],
      hostActionKinds: [],
    });
    expect(Object.isFrozen(options)).toBe(true);
    expect(Object.isFrozen(options.workspaces)).toBe(true);
    expect(Object.isFrozen(options.workspaces[0])).toBe(true);
  });

  test("publishes the immutable GatewayReply route to tool visibility and run services", () => {
    const gateway = {
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
      ],
    };
    const profileParams = {
      hostActions: ["gatewayReply"],
      gateway,
      gatewayReply: {
        button: "link",
        attachments: ["image"],
        maxTextLength: 8_000,
        maxAttachments: 2,
        maxAttachmentBytes: 1_024,
      },
    };
    expect(PET_BEHAVIOR_PROFILE.buildVisibilityMeta?.(profileParams)).toMatchObject({
      petHostActionKinds: ["gatewayReply"],
      petGateway: gateway,
      petGatewayReply: profileParams.gatewayReply,
    });
    const services = PET_BEHAVIOR_PROFILE.createRunServices?.({
      profileParams,
      reportResult: () => undefined,
    });
    expect(services).toMatchObject({
      petGateway: gateway,
      petGatewayReply: profileParams.gatewayReply,
    });
    expect(Object.isFrozen((services as { petGateway: unknown }).petGateway)).toBe(true);
    expect(Object.isFrozen((services as { petGatewayReply: unknown }).petGatewayReply)).toBe(true);
  });

  test("fails closed before exposing malformed direct Engine-hosted profile params", () => {
    const profileParams = {
      workspaces: [{ id: "workspace-a", name: "Alpha" }],
      reusableSessions: [{ id: "orphan", workspaceId: "workspace-b", name: "Must not leak" }],
    };

    expect(PET_BEHAVIOR_PROFILE.buildVisibilityMeta?.(profileParams)).toEqual({
      petWorkspaces: [],
      petReusableSessions: [],
      petHostActionKinds: [],
    });
    expect(
      PET_BEHAVIOR_PROFILE.buildVisibilityMeta?.({ hostActions: ["mobileRemote", "shell"] }),
    ).toMatchObject({ petHostActionKinds: [] });
    expect(
      PET_BEHAVIOR_PROFILE.buildVisibilityMeta?.({ hostActions: ["gatewayReply"] }),
    ).toMatchObject({ petHostActionKinds: [] });
  });
});
