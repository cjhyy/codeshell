import { describe, expect, test } from "bun:test";
import {
  actionHints,
  actionVerbs,
  collectNoticeArtifacts,
  linkDisposition,
  noticeActionCode,
  ordinalLabel,
  parseNoticeActions,
  type NoticeActions,
} from "./pet-notice-action-codes";

const CODE = "0123456789AB";

function actions(patch: Partial<NoticeActions> = {}): NoticeActions {
  return {
    code: CODE,
    family: "goal",
    sessionId: "work-1",
    runtime: "native",
    expiresAt: 1_000,
    ...patch,
  };
}

describe("parseNoticeActions", () => {
  test("accepts every field it knows", () => {
    const full = actions({
      family: "open",
      reason: "limit",
      goalId: "goal-1",
      revision: 2,
      taskId: "task-1",
      retry: true,
      artifacts: [
        { kind: "file", path: "/work/a.ts", label: "a" },
        { kind: "url", url: "https://github.com/o/r/pull/1" },
      ],
      usedAt: 5,
      confirm: { item: 2, expiresAt: 9, usedAt: 8 },
      slot: { channel: "wechat", ordinal: 3 },
    });
    expect(parseNoticeActions(structuredClone(full))).toEqual(full);
  });

  test("rejects unknown keys, bad ids and unsafe artifacts", () => {
    expect(parseNoticeActions({ ...actions(), extra: 1 })).toBeUndefined();
    expect(parseNoticeActions(actions({ code: "0123456789ab" }))).toBeUndefined();
    expect(parseNoticeActions(actions({ family: "other" as never }))).toBeUndefined();
    expect(parseNoticeActions(actions({ revision: 0 }))).toBeUndefined();
    expect(
      parseNoticeActions(actions({ artifacts: [{ kind: "file", path: "relative/a.ts" }] })),
    ).toBeUndefined();
    expect(
      parseNoticeActions(actions({ artifacts: [{ kind: "url", url: "file:///etc/passwd" }] })),
    ).toBeUndefined();
    expect(
      parseNoticeActions(actions({ artifacts: [{ kind: "url", url: "javascript:alert(1)" }] })),
    ).toBeUndefined();
    expect(parseNoticeActions(actions({ slot: { channel: "wechat", ordinal: 100 } }))).toBe(
      undefined,
    );
    expect(parseNoticeActions(null)).toBeUndefined();
  });
});

describe("ids, actions and the reply line", () => {
  test("an id is 12 upper hex and bound to its seed", () => {
    const a = noticeActionCode(["action", "notice-1", "goal"]);
    expect(a).toMatch(/^[0-9A-F]{12}$/u);
    expect(noticeActionCode(["action", "notice-1", "goal"])).toBe(a);
    expect(noticeActionCode(["action", "notice-2", "goal"])).not.toBe(a);
  });

  test("each family offers its actions; a pending link adds confirm", () => {
    expect(actionVerbs(actions({ family: "goal" }))).toEqual(["reply", "stop", "handoff"]);
    expect(actionVerbs(actions({ family: "limit" }))).toEqual(["continue", "stop", "handoff"]);
    expect(actionVerbs(actions({ family: "failure", retry: true }))).toEqual(["retry", "handoff"]);
    expect(actionVerbs(actions({ family: "failure" }))).toEqual(["handoff"]);
    expect(actionVerbs(actions({ family: "open" }))).toEqual(["open"]);
    expect(actionVerbs(actions({ family: "open", confirm: { item: 1, expiresAt: 5 } }))).toEqual([
      "open",
      "confirm",
    ]);
  });

  test("the reply line is plain words, never a code or a command", () => {
    for (const family of ["goal", "limit", "failure", "open"] as const) {
      const line = actionHints(actions({ family, retry: true }));
      expect(line).not.toContain(CODE);
      expect(line).toContain("回我");
    }
    expect(
      actionHints(
        actions({
          family: "open",
          artifacts: [
            { kind: "file", path: "/w/a" },
            { kind: "file", path: "/w/b" },
          ],
        }),
      ),
    ).toBe("想在电脑上打开结果（共 2 项）就回我。");
    expect(ordinalLabel(1)).toBe("①");
    expect(ordinalLabel(20)).toBe("⑳");
    expect(ordinalLabel(21)).toBe("(21)");
  });
});

describe("links and artifacts", () => {
  test("code hosts, extra hosts and localhost open; anything else asks", () => {
    expect(linkDisposition("https://github.com/o/r/pull/3")?.disposition).toBe("open");
    expect(linkDisposition("https://gist.github.com/x")?.disposition).toBe("open");
    expect(linkDisposition("https://gitee.com/o/r")?.disposition).toBe("open");
    expect(linkDisposition("http://localhost:5173/")?.disposition).toBe("open");
    expect(linkDisposition("http://127.0.0.1:3000")?.disposition).toBe("open");
    expect(linkDisposition("https://git.corp.example/o", ["corp.example"])?.disposition).toBe(
      "open",
    );
    expect(linkDisposition("https://github.com.evil.example/x")).toEqual({
      disposition: "confirm",
      host: "github.com.evil.example",
    });
    expect(linkDisposition("https://user:pw@github.com/x")?.disposition).toBe("confirm");
    expect(linkDisposition("file:///etc/hosts")).toBeUndefined();
  });

  test("artifacts come from structured sources only: changed files inside the cwd, task artifacts", () => {
    expect(
      collectNoticeArtifacts({
        changed: { cwd: "/work", paths: ["/work/src/a.ts", "/elsewhere/b.ts", "/work/../c.ts"] },
        task: [
          { kind: "file", label: "Generated image", reference: "/work/out.png" },
          { kind: "result", label: "Completed work session", reference: "work-1" },
          { kind: "file", label: "relative", reference: "out.png" },
          { kind: "url", label: "PR", reference: "https://github.com/o/r/pull/9" },
          { kind: "url", label: "bad", reference: "javascript:alert(1)" },
        ],
      }),
    ).toEqual([
      { kind: "file", path: "/work/src/a.ts" },
      { kind: "file", path: "/work/out.png", label: "Generated image" },
      { kind: "url", url: "https://github.com/o/r/pull/9", label: "PR" },
    ]);
    expect(collectNoticeArtifacts({})).toEqual([]);
  });
});
