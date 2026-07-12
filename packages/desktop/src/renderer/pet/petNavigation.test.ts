import { describe, expect, test } from "bun:test";
import type { PetApi } from "../../preload/types";
import { openPetTarget } from "./petNavigation";

function api(result: Awaited<ReturnType<PetApi["openSession"]>>): PetApi {
  return {
    getSnapshot: async () => ({
      version: 0,
      generation: 0,
      workerState: "reclaimed",
      sessions: [],
      pending: [],
      observedAt: 0,
    }),
    onProjectionEvent: () => () => {},
    openSession: async () => result,
  };
}

describe("openPetTarget", () => {
  test("navigates once by structured binding and reports stale without restoring an action", async () => {
    const selected: string[] = [];
    const stale: string[] = [];
    const result = await openPetTarget(
      api({
        status: "stale",
        pendingStatus: "resolved",
        target: {
          uiSessionId: "session-a",
          engineSessionId: "session-a",
          projectPath: "/work/a",
          title: "A",
          updatedAt: 1,
          origin: "desktop",
        },
      }),
      { agentSessionId: "session-a", snapshotVersion: 4, generation: 2 },
      {
        select: async (target) => selected.push(target.uiSessionId),
        onStale: (pendingStatus) => stale.push(pendingStatus ?? "stale"),
      },
    );

    expect(result).toBe(true);
    expect(selected).toEqual(["session-a"]);
    expect(stale).toEqual(["resolved"]);
  });

  test("fails closed when the target no longer exists", async () => {
    let selected = false;
    const result = await openPetTarget(
      api({ status: "not-found" }),
      { agentSessionId: "missing", snapshotVersion: 4, generation: 2 },
      { select: async () => (selected = true) },
    );
    expect(result).toBe(false);
    expect(selected).toBe(false);
  });
});
