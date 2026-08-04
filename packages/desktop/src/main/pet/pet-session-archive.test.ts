import { describe, expect, test } from "bun:test";
import { sessionSelectorId } from "@cjhyy/code-shell-pet/disclosure";
import { archivePetSessionsBySelector, type PetArchivableSession } from "./pet-session-archive";

const desktop = (id: string, archivedAt?: number): PetArchivableSession => ({
  engineSessionId: id,
  origin: "desktop",
  ...(archivedAt === undefined ? {} : { archivedAt }),
});

describe("archivePetSessionsBySelector", () => {
  test("validates the complete selector batch before writing anything", async () => {
    const writes: string[] = [];
    const first = sessionSelectorId("first");
    await expect(
      archivePetSessionsBySelector({
        selectors: [first, "missing"],
        listSessions: async () => [desktop("first")],
        archiveSession: async (id) => void writes.push(id),
        refreshCatalog: async () => undefined,
      }),
    ).rejects.toThrow("不存在或不允许归档");
    expect(writes).toEqual([]);
  });

  test("archives only desktop sessions, skips already archived rows, and refreshes once", async () => {
    const writes: Array<[string, number]> = [];
    let refreshes = 0;
    const result = await archivePetSessionsBySelector({
      selectors: [sessionSelectorId("old"), sessionSelectorId("fresh")],
      listSessions: async () => [
        desktop("old", 1),
        desktop("fresh"),
        { engineSessionId: "external", origin: "codex" },
      ],
      archiveSession: async (id, at) => void writes.push([id, at]),
      refreshCatalog: async () => void (refreshes += 1),
      now: () => 42,
    });

    expect(writes).toEqual([["fresh", 42]]);
    expect(refreshes).toBe(1);
    expect(result).toEqual({
      action: "archive",
      archived: [sessionSelectorId("fresh")],
      count: 1,
    });
  });

  test("reports a truthful partial result and refreshes after a mid-batch storage failure", async () => {
    const writes: string[] = [];
    let refreshes = 0;
    await expect(
      archivePetSessionsBySelector({
        selectors: [sessionSelectorId("one"), sessionSelectorId("two")],
        listSessions: async () => [desktop("one"), desktop("two")],
        archiveSession: async (id) => {
          if (id === "two") throw new Error("disk full");
          writes.push(id);
        },
        refreshCatalog: async () => void (refreshes += 1),
      }),
    ).rejects.toThrow("部分完成（1/2）：disk full");
    expect(writes).toEqual(["one"]);
    expect(refreshes).toBe(1);
  });

  test("reports completed archives truthfully when the catalog refresh fails", async () => {
    const writes: string[] = [];
    await expect(
      archivePetSessionsBySelector({
        selectors: [sessionSelectorId("one")],
        listSessions: async () => [desktop("one")],
        archiveSession: async (id) => void writes.push(id),
        refreshCatalog: async () => {
          throw new Error("refresh unavailable");
        },
      }),
    ).rejects.toThrow("已归档 1 个 Session，但工作列表刷新失败：refresh unavailable");
    expect(writes).toEqual(["one"]);
  });
});
