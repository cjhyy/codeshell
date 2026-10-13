import { afterEach, expect, test } from "bun:test";
import { randomUUID, createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectRegistry } from "./registry.js";

const origin = "https://accounts.example.test";
const roots: string[] = [],
  stores: ProjectRegistry[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(multi = true, io: { rename?: typeof renameSync } = {}) {
  const root = mkdtempSync(join(tmpdir(), "codeshell-multi-registry-"));
  roots.push(root);
  const store = new ProjectRegistry(root, Date.now, {
    ...io,
    ...(multi ? { multiAccountOrigin: origin } : {}),
  });
  stores.push(store);
  return { root, store, file: join(root, "project-control/registry.json") };
}

test("fresh multi-account installations persist stable UUID ownership and independent credential-free projects", () => {
  const f = fixture(),
    a = randomUUID(),
    b = randomUUID(),
    alice = f.store.ensureAccountOwner(origin, a),
    bob = f.store.ensureAccountOwner(origin, b);
  expect(alice).not.toBe(bob);
  expect(alice).not.toBe(a);
  expect(f.store.ensureAccountOwner(origin, a)).toBe(alice);
  const first = f.store.createAccount(alice, "Same visible project"),
    second = f.store.createAccount(bob, "Same visible project");
  expect(first.runtimePassword).not.toBe(second.runtimePassword);
  expect(f.store.listAccount(alice).map((row) => row.id)).toEqual([first.id]);
  expect(f.store.listAccount(bob).map((row) => row.id)).toEqual([second.id]);
  expect(() => f.store.getAccount(bob, first.id)).toThrow("找不到这个项目");
  expect(() => f.store.getAccount(randomUUID(), first.id)).toThrow("管理权限");
  for (const value of [first.runtimePassword, first.ownerId, a, "accountId", "runtimePassword"])
    expect(JSON.stringify(f.store.listAccount(alice))).not.toContain(value);
  const raw = JSON.parse(readFileSync(f.file, "utf8"));
  expect(raw.version).toBe(3);
  expect(raw.owners[0]).toEqual({ id: alice, accountOrigin: origin, accountId: a });
  expect(raw.owners.some((owner) => "username" in owner)).toBe(false);
  const config = f.store.multiAccount!;
  config.managementEpoch = randomUUID();
  expect(f.store.multiAccount!.managementEpoch).not.toBe(config.managementEpoch);
  f.store.close();
  const reopened = new ProjectRegistry(f.root, Date.now, { multiAccountOrigin: origin });
  stores.push(reopened);
  expect(reopened.ensureAccountOwner(origin, a)).toBe(alice);
  expect(reopened.getAccount(alice, first.id)).toEqual(first);
});

test("legacy/v2 installations cannot be implicitly converted and v3 cannot boot without its exact operator origin", () => {
  for (const version of [1, 2]) {
    const f = fixture(false),
      project = f.store.create("legacy.operator", "Retained");
    if (version === 2)
      f.store.bindAccount({
        version: 1,
        accountOrigin: origin,
        accountId: randomUUID(),
        ownerId: project.ownerId,
        managementEpoch: randomUUID(),
        createdAt: 1,
      });
    f.store.close();
    const bytes = readFileSync(f.file);
    expect(() => new ProjectRegistry(f.root, Date.now, { multiAccountOrigin: origin })).toThrow(
      "fresh installation",
    );
    expect(readFileSync(f.file)).toEqual(bytes);
    const legacy = new ProjectRegistry(f.root);
    stores.push(legacy);
    expect(legacy.accountBinding?.ownerId).toBe(version === 2 ? project.ownerId : undefined);
  }
  const f = fixture();
  f.store.close();
  const bytes = readFileSync(f.file);
  for (const configured of [undefined, "https://different.example.test"]) {
    expect(() => new ProjectRegistry(f.root, Date.now, { multiAccountOrigin: configured })).toThrow(
      "configured Account origin",
    );
    expect(readFileSync(f.file)).toEqual(bytes);
  }
});

test("multi-account identity creation and corruption fail closed without accepting names, foreign origins or unknown metadata", () => {
  const f = fixture();
  for (const [accountOrigin, id] of [
    ["https://foreign.test", randomUUID()],
    [origin, "alice"],
    [origin, "ABCDEFAB-ABCD-4BCD-ABCD-ABCDEFABCDEF"],
  ])
    expect(() => f.store.ensureAccountOwner(accountOrigin, id)).toThrow();
  expect(() => f.store.create("alice", "Bypass")).toThrow();
  expect(() => f.store.list("alice")).toThrow();
  const accountId = randomUUID();
  const ownerId = f.store.ensureAccountOwner(origin, accountId);
  f.store.createAccount(ownerId, "Checked project");
  f.store.close();
  const raw = JSON.parse(readFileSync(f.file, "utf8"));
  for (const mutate of [
    (data) => {
      data.owners.push({ ...data.owners[0], id: randomUUID() });
    },
    (data) => {
      data.owners[0].username = "admin";
    },
    (data) => {
      data.owners[0].accountOrigin = "https://foreign.test";
    },
    (data) => {
      data.unknown = "metadata";
    },
    (data) => {
      data.multiAccount.accountId = accountId;
    },
    (data) => {
      data.projects[0].id = [data.projects[0].id];
    },
    (data) => {
      data.projects[0].runtimePassword = [data.projects[0].runtimePassword];
    },
    (data) => {
      data.projects[0].hostPath = "/must-not-be-replayed";
    },
  ]) {
    const corrupt = structuredClone(raw);
    mutate(corrupt);
    writeFileSync(f.file, JSON.stringify(corrupt));
    expect(() => new ProjectRegistry(f.root, Date.now, { multiAccountOrigin: origin })).toThrow();
  }
});

test("fresh multi-account startup refuses an existing shared Hub authority without writing a registry", () => {
  const root = mkdtempSync(join(tmpdir(), "codeshell-multi-existing-hub-"));
  roots.push(root);
  mkdirSync(join(root, "hub"));
  writeFileSync(join(root, "hub/auth.json"), "synthetic unchanged legacy authority");
  const before = readFileSync(join(root, "hub/auth.json"));
  expect(() => new ProjectRegistry(root, Date.now, { multiAccountOrigin: origin })).toThrow(
    "without legacy Hub",
  );
  expect(readFileSync(join(root, "hub/auth.json"))).toEqual(before);
  expect(existsSync(join(root, "project-control"))).toBe(false);
});

test("failed owner persistence creates no usable owner and restore rotates namespace/epoch without changing ownership or project secrets", () => {
  let fail = false;
  const f = fixture(true, {
      rename: (...args) => {
        if (fail) throw Error("controlled owner persistence failure");
        renameSync(...args);
      },
    }),
    accountId = randomUUID(),
    before = readFileSync(f.file);
  fail = true;
  expect(() => f.store.ensureAccountOwner(origin, accountId)).toThrow("persistence failure");
  expect(readFileSync(f.file)).toEqual(before);
  fail = false;
  const owner = f.store.ensureAccountOwner(origin, accountId),
    project = f.store.createAccount(owner, "Retained");
  f.store.update(project.id, { status: "stopped", generation: 2 });
  const installation = f.store.installationId,
    epoch = f.store.multiAccount!.managementEpoch;
  f.store.renewInstallationForRestore();
  expect(f.store.installationId).not.toBe(installation);
  expect(f.store.multiAccount!.managementEpoch).not.toBe(epoch);
  expect(f.store.ensureAccountOwner(origin, accountId)).toBe(owner);
  expect(f.store.getAccount(owner, project.id).runtimePassword).toBe(project.runtimePassword);
  expect(f.store.getAccount(owner, project.id).generation).toBe(3);
});

test("the actual historical v1 and v2 registry algorithms reject schema 3 without modifying its authority", async () => {
  const f = fixture(),
    owner = f.store.ensureAccountOwner(origin, randomUUID());
  f.store.createAccount(owner, "Retained private project");
  f.store.close();
  const before = readFileSync(f.file);
  for (const [revision, expected] of [
    ["9fa1194e", "c74433a4907fb4e9bc72fd1b737676e427360c6cebfb29b3bf8dd164238024fd"],
    ["7ad788da4", "29e332cdfcc758fdb8b6e6340bed25e55e892f460decf0831ea058bc94f8e68d"],
  ]) {
    const source = readFileSync(
      new URL(`./fixtures/registry-${revision}.ts.txt`, import.meta.url),
      "utf8",
    );
    expect(createHash("sha256").update(source).digest("hex")).toBe(expected);
    const file = join(f.root, `historical-registry-${revision}.ts`);
    writeFileSync(
      file,
      source
        .replace('"./lock.js"', JSON.stringify(import.meta.resolve("./lock.ts")))
        .replace(
          '"./account-binding.js"',
          JSON.stringify(import.meta.resolve("./account-binding.ts")),
        ),
    );
    const { ProjectRegistry: OldRegistry } = await import(file);
    expect(() => new OldRegistry(f.root)).toThrow("registry is corrupt");
    expect(readFileSync(f.file)).toEqual(before);
  }
});
