import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CredentialStore } from "./store.js";
import { PlaintextCipher } from "./cipher.js";
import type { Credential } from "./types.js";

const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const cipher = {
  encrypt: (s: string) => "enc:test:" + Buffer.from(s).toString("base64"),
  decrypt: (s: string) => Buffer.from(s.slice(9), "base64").toString(),
  canDecrypt: (s: string) => s.startsWith("enc:test:"),
};
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "link-retirement-"));
  directories.push(dir);
  return {
    dir,
    store: new CredentialStore(undefined, cipher, dir),
    restart: () => new CredentialStore(undefined, cipher, dir),
  };
}
function credential(grant: string): Credential {
  return {
    id: "link-account",
    type: "oauth",
    label: "Account",
    secret: `private-${grant}`,
    meta: {
      linkExecutionRuntime: "server",
      linkExecutionBackend: "remote",
      linkRemoteIssuer: "https://link.example",
      linkRemoteGrantId: grant,
    },
  };
}
test("retired secrets are encrypted, hidden and preserved by ordinary writes and old readers", () => {
  const { dir, store, restart } = fixture();
  store.stageRemoteLinkRetirement(credential("one"), 10);
  store.save("user", { id: "neighbor", label: "Neighbor", type: "token", secret: "other" });
  expect(store.list().map((c) => c.id)).toEqual(["neighbor"]);
  expect(store.resolve("link-account")).toBeUndefined();
  expect(JSON.stringify(store.listMasked())).not.toContain("private-");
  expect(store.envExposures("full")).toEqual({});
  const disk = readFileSync(join(dir, "credentials.json"), "utf8");
  expect(disk).not.toContain("private-one");
  expect(restart().remoteLinkRetirementCount()).toBe(1);
  // A reader lacking the cipher keeps the unknown private record verbatim.
  const foreign = new CredentialStore(undefined, new PlaintextCipher(), dir);
  expect(foreign.claimRemoteLinkRetirement(20)).toBeUndefined();
  expect(foreign.remoteLinkRetirementCount()).toBe(1);
});
test("grant adoption and old grant retention are atomic and conflict leaves custody intact", () => {
  const { store, restart } = fixture();
  const old = credential("old"),
    next = credential("new");
  store.save("user", old);
  const staged = store.stageRemoteLinkRetirement(next, 10_000);
  expect(
    store.compareAndSwap("user", old.id, { ...old, label: "stale" }, next, {
      retireExpected: true,
      adopt: staged,
      now: 1,
    }),
  ).toBe(false);
  expect(store.remoteLinkRetirementCount()).toBe(1);
  expect(
    store.compareAndSwap("user", old.id, old, next, {
      retireExpected: true,
      adopt: staged,
      now: 1,
    }),
  ).toBe(true);
  const recovered = restart();
  expect(recovered.remoteLinkRetirementCount()).toBe(1);
  expect(recovered.resolve(old.id)?.secret).toBe(next.secret);
  const claim = recovered.claimRemoteLinkRetirement(2)!;
  expect(claim.credential.secret).toBe(old.secret);
  recovered.finishRemoteLinkRetirement(claim, true, 3);
  expect(recovered.remoteLinkRetirementCount()).toBe(0);
});
test("store-wide leases, persisted backoff and expired-lease recovery exclude stale acknowledgments", () => {
  const { store, restart } = fixture();
  store.stageRemoteLinkRetirement(credential("one"), 0);
  const one = store.claimRemoteLinkRetirement(0)!;
  expect(restart().claimRemoteLinkRetirement(1)).toBeUndefined();
  const two = restart().claimRemoteLinkRetirement(60_001)!;
  expect(two.leaseId).not.toBe(one.leaseId);
  store.finishRemoteLinkRetirement(one, true, 60_002);
  expect(store.remoteLinkRetirementCount()).toBe(1);
  store.finishRemoteLinkRetirement(two, false, 60_003);
  expect(restart().claimRemoteLinkRetirement(90_002)).toBeUndefined();
  const retry = restart().claimRemoteLinkRetirement(90_003)!;
  expect(retry.id).toBe(one.id);
  store.finishRemoteLinkRetirement(retry, true, 90_004);
  expect(store.remoteLinkRetirementCount()).toBe(0);
});
test("active grants remain protected after rename or token rotation and staged attempts wait", () => {
  const { store } = fixture();
  const original = credential("one");
  const id = store.stageRemoteLinkRetirement(original, 100);
  expect(store.claimRemoteLinkRetirement(99)).toBeUndefined();
  store.save("user", { ...original, label: "Renamed", secret: "rotated-token" });
  expect(store.claimRemoteLinkRetirement(101)).toBeUndefined();
  store.remove("user", original.id);
  store.readyRemoteLinkRetirement(id, 102);
  expect(store.claimRemoteLinkRetirement(102)?.id).toBe(id);
});
test("unreadable private payload is retained without blocking another cleanup or exposing its bytes", () => {
  const { store, dir } = fixture();
  store.stageRemoteLinkRetirement(credential("one"), 0);
  const file = join(dir, "credentials.json");
  const disk = JSON.parse(readFileSync(file, "utf8"));
  disk.credentials[0].secret = "enc:foreign:unreadable";
  writeFileSync(file, JSON.stringify(disk));
  store.stageRemoteLinkRetirement(credential("two"), 0);
  const claim = store.claimRemoteLinkRetirement(1)!;
  expect(claim.credential.secret).toBe("private-two");
  store.finishRemoteLinkRetirement(claim, true, 2);
  expect(store.remoteLinkRetirementCount()).toBe(1);
  expect(store.list()).toEqual([]);
  expect(readFileSync(file, "utf8")).toContain("enc:foreign:unreadable");
});

test("independent processes can claim each retirement only once", async () => {
  const { dir } = fixture();
  const store = new CredentialStore(undefined, new PlaintextCipher(), dir);
  store.stageRemoteLinkRetirement(credential("one"), 0);
  const script = `
    import { CredentialStore } from ${JSON.stringify(join(import.meta.dir, "store.ts"))};
    const claim = new CredentialStore(undefined, undefined, process.argv[1]).claimRemoteLinkRetirement(1);
    process.stdout.write(claim ? "claimed" : "busy");
  `;
  const children = Array.from({ length: 4 }, () =>
    Bun.spawn([process.execPath, "-e", script, dir], { stdout: "pipe", stderr: "pipe" }),
  );
  const outputs = await Promise.all(
    children.map(async (child) => {
      const output = await new Response(child.stdout).text();
      expect(await child.exited).toBe(0);
      return output;
    }),
  );
  expect(outputs.filter((v) => v === "claimed")).toHaveLength(1);
  expect(store.remoteLinkRetirementCount()).toBe(1);
});

test("a claimed or missing provisional grant cannot be adopted as an active connection", () => {
  const { store } = fixture();
  const next = credential("new");
  const id = store.stageRemoteLinkRetirement(next, 0);
  const claim = store.claimRemoteLinkRetirement(1)!;
  expect(() =>
    store.compareAndSwap("user", next.id, null, next, { retireExpected: false, adopt: id, now: 2 }),
  ).toThrow("custody changed");
  expect(store.list()).toEqual([]);
  store.finishRemoteLinkRetirement(claim, true, 3);
  expect(() =>
    store.compareAndSwap("user", next.id, null, next, { retireExpected: false, adopt: id, now: 4 }),
  ).toThrow("custody changed");
  expect(store.list()).toEqual([]);
});
