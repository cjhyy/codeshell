import { describe, expect, test } from "bun:test";
import { normalizePetWorkDelegation, type PetWorkDelegation } from "./delegation.js";
import { PET_BEHAVIOR_PROFILE, type PetRunScopedServices } from "./profile.js";

const WORKSPACES = [{ id: "ws-one", name: "CodeShell" }];
const SESSIONS = [
  {
    id: "session-one",
    workspaceId: "ws-one",
    name: "梳理项目目录结构",
    description: "status=completed; updated=2026-09-07T10:00:00Z",
  },
];
const NEW_REQUEST: PetWorkDelegation = {
  workspaceId: "ws-one",
  objective: "核查飞书文档并报告访问结果",
};
const CONTINUATION: PetWorkDelegation = {
  workspaceId: "ws-one",
  objective: "补上刚才目录结构总结中遗漏的 pet 模块",
  reusableSessionId: "session-one",
  continuationEvidence: {
    priorThread: "梳理项目目录结构",
    reason: "沿用刚才梳理的目录和模块职责总结，补上其中遗漏的 pet 模块。",
  },
};

function runServices() {
  const reported: Record<string, unknown> = {};
  const services = PET_BEHAVIOR_PROFILE.createRunServices!({
    profileParams: { workspaces: WORKSPACES, reusableSessions: SESSIONS },
    reportResult: (key, value) => {
      reported[key] = value;
    },
  }) as unknown as PetRunScopedServices;
  return { services, reported };
}

describe("Pet work continuation gate", () => {
  test("a valid selector alone cannot resume unrelated work", () => {
    expect(
      normalizePetWorkDelegation({ ...NEW_REQUEST, reusableSessionId: "session-one" }, SESSIONS),
    ).toEqual({
      ok: true,
      delegation: NEW_REQUEST,
      sessionDecision: {
        mode: "new",
        reason: "missing_continuation_evidence",
        requestedSessionId: "session-one",
      },
    });
  });

  test("accepts explicit continuation grounded in the chosen prior work", () => {
    expect(normalizePetWorkDelegation(CONTINUATION, SESSIONS)).toMatchObject({
      ok: true,
      delegation: CONTINUATION,
      sessionDecision: { mode: "reuse", reason: "grounded_continuation" },
    });
  });

  test("rejects invented prior work and requires a full candidate quote", () => {
    for (const priorThread of ["核查飞书文档", "项目", SESSIONS[0]!.description]) {
      expect(
        normalizePetWorkDelegation(
          {
            ...CONTINUATION,
            continuationEvidence: { priorThread, reason: "Continue the previous task." },
          },
          SESSIONS,
        ),
      ).toMatchObject({
        ok: true,
        delegation: { workspaceId: CONTINUATION.workspaceId, objective: CONTINUATION.objective },
        sessionDecision: { mode: "new", reason: "unmatched_prior_thread" },
      });
    }
  });

  test("evidence without a selector cannot turn new work into reuse", () => {
    expect(
      normalizePetWorkDelegation(
        {
          ...NEW_REQUEST,
          continuationEvidence: CONTINUATION.continuationEvidence,
        },
        SESSIONS,
      ),
    ).toEqual({
      ok: true,
      delegation: NEW_REQUEST,
      sessionDecision: { mode: "new", reason: "new_work" },
    });
  });

  test.each([
    null,
    {},
    { priorThread: "梳理项目目录结构" },
    { priorThread: "梳理项目目录结构", reason: " " },
    { priorThread: "梳理项目目录结构", reason: "x".repeat(2_001) },
  ])("rejects malformed continuity evidence at the service boundary: %j", (evidence) => {
    const { services, reported } = runServices();
    expect(
      services.requestPetWorkDelegation({
        ...CONTINUATION,
        continuationEvidence: evidence as PetWorkDelegation["continuationEvidence"],
      }),
    ).toMatchObject({
      ok: true,
      sessionDecision: { mode: "new", reason: "invalid_continuation_evidence" },
    });
    expect(reported.workDelegation).not.toHaveProperty("reusableSessionId");
    expect(reported.workDelegation).not.toHaveProperty("continuationEvidence");
  });

  test("run services enforce the gate even when the tool is bypassed", () => {
    const { services, reported } = runServices();
    expect(
      services.requestPetWorkDelegation({ ...NEW_REQUEST, reusableSessionId: "session-one" }),
    ).toMatchObject({
      ok: true,
      sessionDecision: { mode: "new", reason: "missing_continuation_evidence" },
    });
    expect(reported.workDelegation).toEqual(NEW_REQUEST);
    expect(services.requestPetWorkDelegation(CONTINUATION).ok).toBe(false);
  });

  test("run services preserve grounded continuation and reject wrong selectors before fallback", () => {
    const { services, reported } = runServices();
    for (const request of [
      { ...NEW_REQUEST, reusableSessionId: "invented" },
      { ...NEW_REQUEST, reusableSessionId: " session-one " },
      { ...NEW_REQUEST, workspaceId: "other", reusableSessionId: "session-one" },
    ]) {
      expect(services.requestPetWorkDelegation(request).ok).toBe(false);
      expect(reported.workDelegation).toBeUndefined();
    }
    expect(
      normalizePetWorkDelegation({ ...CONTINUATION, workspaceId: "other" }, SESSIONS),
    ).toMatchObject({ ok: false, error: expect.stringContaining("belongs to Workspace") });
    expect(services.requestPetWorkDelegation(CONTINUATION)).toMatchObject({
      ok: true,
      sessionDecision: { mode: "reuse" },
    });
    expect(reported.workDelegation).toEqual(CONTINUATION);
  });
});
