import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostBusinessCalls, claimBusinessCommit } from "../../host/composition/business-calls.js";
import { SessionCatalogStore } from "../session-catalog-store.js";

test("a withdrawn catalog edit cannot create a draft, while an acknowledged edit survives a fresh reader", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codeshell-catalog-grants-"));
  try {
    const file = join(dir, "catalog.json");
    const store = new SessionCatalogStore({ file });
    const wait = Promise.withResolvers<void>();
    const calls = new HostBusinessCalls({
      "operations/ledger": () => {
        throw new Error("Unexpected operation");
      },
      "catalog/load": () => store.load(),
      "catalog/importLegacy": (indices, grant) =>
        store.commitLegacy(indices, () => claimBusinessCommit(grant.permit)),
      "catalog/apply": async (patch, grant) => {
        await wait.promise;
        return store.commitPatch(patch, () => claimBusinessCommit(grant.permit));
      },
    });
    const patch = {
      projectKey: "project",
      upserts: [
        {
          id: "draft",
          values: { title: "Draft", createdAt: 1, updatedAt: 2, pendingFirstRun: true },
        },
      ],
    };
    const pending = calls.run("1", "catalog/apply", patch);
    calls.revoke("1");
    wait.resolve();
    await expect(pending).rejects.toThrow("revoked");
    expect((await store.load()).indices).toEqual({});
    await calls.run("2", "catalog/apply", patch);
    calls.revoke("2");
    expect((await new SessionCatalogStore({ file }).load()).indices.project.sessions[0].id).toBe(
      "draft",
    );
    await expect(calls.run("3", "__proto__", {})).rejects.toThrow("Unknown");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
