import { describe, expect, test } from "bun:test";
import { mimiWorldLedgerProviders, MIMI_LEDGER_LISTS } from "./world-ledger.js";

const mimi = { session: { id: "pet-1", kind: "pet", profileId: "pet", isSubAgent: false } };
const run = (ledgerContext: unknown, session = mimi.session) =>
  Promise.all(
    mimiWorldLedgerProviders().map((provider) =>
      provider({
        cwd: "/x",
        preset: {} as never,
        workspace: {} as never,
        session,
        runParams: { ledgerContext },
      }),
    ),
  );

describe("Mimi world ledger providers", () => {
  test("turns each durable list into its own section with one entry per item", async () => {
    const sections = await run(
      JSON.stringify({
        workspaces: [
          { id: "w1", name: "Alpha" },
          { id: "w2", name: "Beta" },
        ],
        sessions: [{ sessionId: "s1", title: "Login" }],
        followUps: [],
      }),
    );
    const byKey = Object.fromEntries(
      sections.filter(Boolean).map((section) => [(section as { key: string }).key, section]),
    );
    expect(Object.keys(byKey)).toEqual(["mimi-workspaces", "mimi-sessions", "mimi-follow-ups"]);
    expect(byKey["mimi-workspaces"]).toMatchObject({
      header: expect.stringContaining("[workspaces]"),
      items: [
        { id: "w1", text: '{"id":"w1","name":"Alpha"}' },
        { id: "w2", text: '{"id":"w2","name":"Beta"}' },
      ],
    });
    expect(byKey["mimi-sessions"]).toMatchObject({ items: [{ id: "s1" }] });
    expect(byKey["mimi-follow-ups"]).toMatchObject({ items: [], footer: "(none)" });
  });

  test("a list missing from the sent lists produces no section; other Sessions get nothing", async () => {
    expect((await run(JSON.stringify({ workspaces: [] }))).filter(Boolean)).toHaveLength(1);
    const work = { id: "s-1", kind: "work", profileId: "general", isSubAgent: false };
    expect((await run(JSON.stringify({ workspaces: [] }), work)).filter(Boolean)).toHaveLength(0);
    expect(MIMI_LEDGER_LISTS).toContain("reusableSessions");
  });

  test("a Mimi turn without usable lists keeps every list as last told", async () => {
    const unchanged = MIMI_LEDGER_LISTS.map(() => ({
      key: expect.stringMatching(/^mimi-[a-z-]+$/),
      unchanged: true,
    }));
    expect(await run(undefined)).toEqual(unchanged);
    expect(await run("not json")).toEqual(unchanged);
    expect((await run(undefined))[1]).toEqual({ key: "mimi-reusable-sessions", unchanged: true });
    const work = { id: "s-1", kind: "work", profileId: "general", isSubAgent: false };
    expect((await run(undefined, work)).filter(Boolean)).toHaveLength(0);
  });
});
