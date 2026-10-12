import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  fsyncSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HubAuthStore } from "../hub/auth-store.js";
import { ProjectRegistry } from "./registry.js";
import { adoptCloudAccount } from "./account-adoption.js";
import { CLOUD_ADOPTION_PENDING } from "./account-binding.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cs-account-adoption-")));
  const evidenceRoot = realpathSync(mkdtempSync(join(tmpdir(), "cs-account-adoption-evidence-")));
  roots.push(root, evidenceRoot);
  const registry = new ProjectRegistry(root);
  const project = registry.create("legacy.operator", "Retained project");
  const installationId = registry.installationId;
  registry.close();
  const auth = new HubAuthStore({ dataDir: root });
  const bootstrap = auth.initialize()!;
  const grant = await auth.setup({
    token: bootstrap,
    username: "legacy.operator",
    password: "synthetic fixture password",
  });
  const options = {
    dataDir: root,
    evidenceDirectory: join(evidenceRoot, "evidence"),
    installationId,
    ownerId: project.ownerId,
    legacyUsername: "legacy.operator",
    accountOrigin: "https://account.fixture.invalid",
    accountId: randomUUID(),
  };
  const registryFile = join(root, "project-control/registry.json");
  const authFile = join(root, "hub/auth.json");
  return {
    root,
    options,
    project,
    auth,
    grant,
    registryFile,
    authFile,
    pending: join(root, "project-control", CLOUD_ADOPTION_PENDING),
  };
}

test("explicit offline adoption preserves project identities and credentials while retiring username authority", async () => {
  const f = await fixture();
  const originalRegistry = readFileSync(f.registryFile),
    originalAuth = readFileSync(f.authFile);
  const result = adoptCloudAccount(f.options);
  expect(readFileSync(join(result.evidenceDirectory, "project-control--registry.json"))).toEqual(
    originalRegistry,
  );
  expect(readFileSync(join(result.evidenceDirectory, "hub--auth.json"))).toEqual(originalAuth);
  expect(f.auth.authenticate(f.grant.token)).toBeNull();
  const registry = new ProjectRegistry(f.root);
  try {
    expect(registry.getAccount(f.project.ownerId, f.project.id)).toEqual(f.project);
    expect(() => registry.get("legacy.operator", f.project.id)).toThrow("云账号管理");
    expect(() => registry.create("legacy.operator", "Cannot reclaim")).toThrow();
    expect(() => registry.listAccount(randomUUID())).toThrow();
    const created = registry.createAccount(f.project.ownerId, "New managed project");
    expect(created.ownerId).toBe(f.project.ownerId);
    expect(registry.listAccount(f.project.ownerId)).toHaveLength(2);
    const epoch = registry.accountBinding!.managementEpoch;
    registry.renewInstallationForRestore();
    expect(registry.installationId).not.toBe(f.options.installationId);
    expect(registry.accountBinding!.managementEpoch).not.toBe(epoch);
    expect(registry.accountBinding!.accountId).toBe(f.options.accountId);
    expect(registry.getAccount(f.project.ownerId, f.project.id).runtimePassword).toBe(
      f.project.runtimePassword,
    );
  } finally {
    registry.close();
  }
});

test("every actual fsync failure preserves evidence/source and deterministically retries the same adoption", async () => {
  const baseline = await fixture();
  let count = 0;
  adoptCloudAccount({
    ...baseline.options,
    io: {
      fsync(fd) {
        count++;
        fsyncSync(fd);
      },
    },
  });
  expect(count).toBeGreaterThan(20);
  console.info(`Cloud adoption actual fsync cut points: ${count}`);
  for (let cut = 1; cut <= count; cut++) {
    const f = await fixture();
    const originals = [readFileSync(f.registryFile), readFileSync(f.authFile)];
    let calls = 0;
    expect(() =>
      adoptCloudAccount({
        ...f.options,
        io: {
          fsync(fd) {
            if (++calls === cut) throw new Error("fixture fsync fault");
            fsyncSync(fd);
          },
        },
      }),
    ).toThrow("fixture fsync fault");
    if (existsSync(f.pending))
      expect(() => new ProjectRegistry(f.root)).toThrow("adoption is incomplete");
    const result = adoptCloudAccount(f.options);
    expect(existsSync(f.pending)).toBe(false);
    expect(readFileSync(join(result.evidenceDirectory, "project-control--registry.json"))).toEqual(
      originals[0],
    );
    expect(readFileSync(join(result.evidenceDirectory, "hub--auth.json"))).toEqual(originals[1]);
    expect(f.auth.authenticate(f.grant.token)).toBeNull();
    expect(adoptCloudAccount(f.options).binding).toEqual(result.binding);
  }
}, 30000);

test("unknown source changes and wrong explicit identity never get adopted on retry", async () => {
  const f = await fixture();
  for (const patch of [
    { accountId: "wrong" },
    { ownerId: randomUUID() },
    { installationId: randomUUID() },
    { legacyUsername: "same.account.display.name" },
    { evidenceDirectory: join(f.root, "evidence") },
  ])
    expect(() => adoptCloudAccount({ ...f.options, ...patch })).toThrow();
  let bound = false;
  expect(() =>
    adoptCloudAccount({
      ...f.options,
      io: {
        fsync(fd) {
          const data = JSON.parse(readFileSync(f.registryFile, "utf8"));
          if (data.version === 2) {
            bound = true;
            throw new Error("post bind fault");
          }
          fsyncSync(fd);
        },
      },
    }),
  ).toThrow();
  expect(bound).toBe(true);
  const changed = JSON.parse(readFileSync(f.authFile, "utf8"));
  changed.account.username = "other.operator";
  writeFileSync(f.authFile, JSON.stringify(changed), { mode: 0o600 });
  const evidence = readFileSync(join(f.options.evidenceDirectory, "receipt.json"));
  expect(() => adoptCloudAccount(f.options)).toThrow("source changed");
  expect(() => adoptCloudAccount(f.options)).toThrow("source changed");
  expect(readFileSync(join(f.options.evidenceDirectory, "receipt.json"))).toEqual(evidence);
  expect(existsSync(f.pending)).toBe(true);
});

test("pending marker including a dangling symlink blocks a cold controller", async () => {
  const f = await fixture();
  symlinkSync(join(f.root, "does-not-exist"), f.pending);
  expect(() => new ProjectRegistry(f.root)).toThrow("adoption is incomplete");
  expect(() => adoptCloudAccount(f.options)).toThrow();
});

test("the real previous registry algorithm rejects the format barrier without rewriting authority", async () => {
  const f = await fixture();
  adoptCloudAccount(f.options);
  const before = readFileSync(f.registryFile);
  const oldSource = execFileSync(
    "git",
    ["show", "9fa1194e:packages/server/src/project-runtime/registry.ts"],
    { encoding: "utf8" },
  );
  const file = join(f.root, "historical-registry.ts");
  writeFileSync(
    file,
    oldSource.replace('"./lock.js"', JSON.stringify(import.meta.resolve("./lock.ts"))),
  );
  const { ProjectRegistry: OldRegistry } = await import(file);
  expect(() => new OldRegistry(f.root)).toThrow("registry is corrupt");
  expect(readFileSync(f.registryFile)).toEqual(before);
});
