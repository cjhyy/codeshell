import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HostBusinessCalls } from "./business-calls.js";
import { hostedMimiFollowUps } from "./mimi-follow-ups.js";
import { PetWorkInboxStore } from "../../main/pet/pet-work-inbox-store.js";

const input = {
  sessions: [
    {
      agentSessionId: "work",
      title: "Fixture",
      terminal: { status: "completed" as const, at: 123 },
    },
  ],
  registered: [],
};
describe("hosted Mimi follow-ups", () => {
  test("shared requests issue one inference, and replacement restores the v2 row and its single claim", async () => {
    const dir = await mkdtemp(join(tmpdir(), "host-follow-up-"));
    let calls = 0;
    const live = async () => {
      const inbox = new PetWorkInboxStore(join(dir, "work-inbox.json"));
      await inbox.load();
      const host = hostedMimiFollowUps({
        petDir: dir,
        sessionsDir: dir,
        history: { mimiSummaryInput: async (id) => (id === "work" ? "Choose a day?" : null) },
        generationAllowed: () => true,
        managerId: async () => "pet-manager",
        inbox: () => inbox,
        generate: async () => {
          calls++;
          return "FOLLOW_UP: Choose a day";
        },
      });
      return new HostBusinessCalls(host.methods);
    };
    try {
      const first = await live();
      const [rows, open] = await Promise.all([
        first.run("a", "mimi/followUps", input),
        first.run("b", "mimi/openFollowUps", input),
      ]);
      expect(rows).toMatchObject([{ text: "Choose a day", sessionId: "work" }]);
      expect(open).toMatchObject([{ text: "Choose a day", kind: "derived-session" }]);
      expect(calls).toBe(1);
      expect(JSON.parse(await readFile(join(dir, "summaries.json"), "utf8")).version).toBe(2);
      const id = (rows as { followUpId: string }[])[0]!.followUpId;
      const mutation = { ...input, mutation: { action: "complete", followUpId: id } };
      const claims = await Promise.allSettled([
        first.run("c", "mimi/handleFollowUp", mutation),
        first.run("d", "mimi/handleFollowUp", mutation),
      ]);
      expect(claims.filter((row) => row.status === "fulfilled")).toHaveLength(1);
      first.close();
      const replacement = await live();
      expect(
        await replacement.run("e", "mimi/followUps", {
          ...input,
          options: { allowGenerate: false },
        }),
      ).toEqual(rows);
      expect(await replacement.run("f", "mimi/openFollowUps", input)).toEqual([]);
      expect(calls).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  test("revocation during the history read does not spend inference or suppress a later retry", async () => {
    const dir = await mkdtemp(join(tmpdir(), "host-follow-up-"));
    let calls = 0;
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<string>();
    try {
      const inbox = new PetWorkInboxStore(join(dir, "inbox.json"));
      const host = new HostBusinessCalls(
        hostedMimiFollowUps({
          petDir: dir,
          sessionsDir: dir,
          managerId: async () => "pet-manager",
          inbox: () => inbox,
          generationAllowed: () => true,
          generate: async () => {
            calls++;
            return "FOLLOW_UP: Choose a day";
          },
          history: {
            mimiSummaryInput: async () => {
              entered.resolve();
              return release.promise;
            },
          },
        }).methods,
      );
      const pending = host.run("old", "mimi/followUps", input);
      await entered.promise;
      host.revoke("old");
      release.resolve("Choose a day?");
      await expect(pending).rejects.toThrow("no longer owns");
      expect(calls).toBe(0);
      expect(await host.run("new", "mimi/followUps", input)).toMatchObject([
        { text: "Choose a day" },
      ]);
      expect(calls).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
