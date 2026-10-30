import { describe, expect, test } from "bun:test";
import type { PetApi } from "../../preload/types";
import { translate } from "../i18n/translate";
import { createPetTargetNavigator } from "./createPetTargetNavigator";

describe("createPetTargetNavigator stale feedback", () => {
  for (const lang of ["zh", "en"] as const) {
    for (const pendingStatus of ["pending", "resolved", undefined] as const) {
      test(`${lang}: distinguishes ${pendingStatus ?? "session metadata"} from a handled request`, async () => {
        const target = {
          uiSessionId: "session-a",
          engineSessionId: "session-a",
          projectPath: "/work/a",
          title: "A",
          updatedAt: 1,
          origin: "desktop" as const,
        };
        const opened: string[] = [];
        const viewed: string[] = [];
        const messages: string[] = [];
        const navigate = createPetTargetNavigator({
          api: {
            openSession: async () => ({ status: "stale", pendingStatus, target }),
          } as PetApi,
          activeBucketRef: { current: "bucket" },
          updatePanelBucket: () => {},
          setView: () => {},
          isNarrowWindow: false,
          markViewedPetCompletions: (id) => viewed.push(id!),
          openDiskSession: async (session) => {
            opened.push(session.id);
          },
          toast: (options) => {
            messages.push(options.message);
          },
          t: (key, params) => translate(lang, key, params),
        });

        expect(
          await navigate({
            agentSessionId: "session-a",
            snapshotVersion: 4,
            generation: 2,
            requestId: pendingStatus ? "request-a" : undefined,
          }),
        ).toBe(true);
        expect(opened).toEqual(["session-a"]);
        expect(viewed).toEqual(["session-a"]);
        expect(messages).toEqual(
          pendingStatus === "pending"
            ? []
            : [
                pendingStatus === "resolved"
                  ? lang === "zh"
                    ? "该请求已结束；已打开原会话"
                    : "The request is no longer active; opened the original session"
                  : lang === "zh"
                    ? "状态已更新；已打开原会话"
                    : "The session state changed; opened the original session",
              ],
        );
      });
    }
  }
});
