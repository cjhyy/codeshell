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
  });
});
