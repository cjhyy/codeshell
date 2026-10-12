import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CloudBindingInput } from "../shared/project-runtime.js";
import { ProjectRuntimeStore } from "./project-runtime-store.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "codeshell-project-runtime-"));
  roots.push(root);
  const file = join(root, "runtime.json");
  const input: CloudBindingInput = {
    localProjectId: randomUUID(),
    origin: "https://cloud.example",
    environmentId: randomUUID(),
    environmentName: "云端",
    remoteProjectId: randomUUID(),
    remoteProjectName: "现有项目",
  };
  return { root, file, input, store: new ProjectRuntimeStore(file) };
}

test("bindings and selected runtime survive restart with stable identities and owner-only files", () => {
  const { root, file, input, store } = fixture();
  expect(store.getSelection(input.localProjectId)).toEqual({
    localProjectId: input.localProjectId,
    bindingId: null,
  });
  const binding = store.upsert({ ...input, origin: "https://CLOUD.example:443/" });
  expect(binding.origin).toBe(input.origin);
  expect(binding.id).toMatch(/^[a-f0-9-]{36}$/);
  expect(store.setSelection(input.localProjectId, binding.id).bindingId).toBe(binding.id);
  const reopened = new ProjectRuntimeStore(file);
  expect(reopened.list(input.localProjectId)).toEqual([binding]);
  expect(reopened.getSelection(input.localProjectId).bindingId).toBe(binding.id);
  const renamed = reopened.upsert({ ...input, remoteProjectName: "新名称" });
  expect(renamed.id).toBe(binding.id);
  expect(renamed.createdAt).toBe(binding.createdAt);
  expect(renamed.updatedAt).toBeGreaterThanOrEqual(binding.updatedAt);
  expect(store.get(binding.id)?.remoteProjectName).toBe("新名称");
  if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(readdirSync(root).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
});

test("distinct projects and environments remain separate; foreign selections are rejected", () => {
  const { file, input, store } = fixture();
  const first = store.upsert(input);
  const second = new ProjectRuntimeStore(file).upsert({ ...input, localProjectId: randomUUID() });
  expect(first.id).not.toBe(second.id);
  expect(store.list()).toHaveLength(2);
  const before = readFileSync(file, "utf8");
  expect(() => store.setSelection(input.localProjectId, second.id)).toThrow("当前本地项目");
  expect(() => store.setSelection(input.localProjectId, randomUUID())).toThrow();
  expect(readFileSync(file, "utf8")).toBe(before);
  expect(() => store.upsert({ ...input, environmentId: randomUUID() })).toThrow("环境身份已变化");
  expect(store.upsert({ ...input, origin: "https://moved.example" }).id).toBe(first.id);
  const other = store.upsert({
    ...input,
    origin: "https://another.example",
    environmentId: randomUUID(),
  });
  expect(other.id).not.toBe(first.id);
});

test("removing one binding resets its selection without affecting another project", () => {
  const { input, store } = fixture();
  const first = store.upsert(input);
  const second = store.upsert({ ...input, localProjectId: randomUUID() });
  store.setSelection(first.localProjectId, first.id);
  store.setSelection(second.localProjectId, second.id);
  store.remove(first.id);
  expect(store.get(first.id)).toBeUndefined();
  expect(store.getSelection(first.localProjectId).bindingId).toBeNull();
  expect(store.getSelection(second.localProjectId).bindingId).toBe(second.id);
  store.setSelection(second.localProjectId, null);
  expect(store.getSelection(second.localProjectId).bindingId).toBeNull();
});

test("credential-bearing, non-origin and insecure addresses are rejected before persistence", () => {
  const { input, store, file } = fixture();
  for (const origin of [
    "http://cloud.example",
    "https://user:secret@cloud.example",
    "https://cloud.example/project",
    "https://cloud.example?token=secret",
    "https://cloud.example#fragment",
    "https://cloud.example/\\path",
  ])
    expect(() => store.upsert({ ...input, origin })).toThrow();
  expect(() => store.upsert({ ...input, token: "secret" } as CloudBindingInput)).toThrow();
  expect(() => store.upsert({ ...input, environmentId: "../host" })).toThrow();
  expect(() => store.upsert({ ...input, remoteProjectName: "line\nbreak" })).toThrow();
  expect(() => statSync(file)).toThrow();
  for (const origin of ["http://localhost:4321", "http://127.0.0.1:4321", "http://[::1]:4321"]) {
    expect(store.upsert({ ...input, origin, remoteProjectId: randomUUID() }).origin).toBe(origin);
  }
});

test("corrupt snapshots block both reads and mutations without destroying evidence", () => {
  const { input, store, file } = fixture();
  const binding = store.upsert(input);
  const valid = JSON.parse(readFileSync(file, "utf8"));
  const invalid = [
    "{bad JSON",
    JSON.stringify({ ...valid, version: 2 }),
    JSON.stringify({ ...valid, bindings: [...valid.bindings, binding] }),
    JSON.stringify({ ...valid, token: "forbidden" }),
    JSON.stringify({
      ...valid,
      selections: [{ localProjectId: randomUUID(), bindingId: binding.id }],
    }),
    JSON.stringify({ ...valid, bindings: [{ ...binding, environmentId: "invalid" }] }),
    " ".repeat(4 * 1024 * 1024 + 1),
  ];
  for (const contents of invalid) {
    writeFileSync(file, contents);
    expect(() => store.list()).toThrow();
    expect(() => store.getSelection(input.localProjectId)).toThrow();
    expect(() => store.upsert(input)).toThrow();
    expect(readFileSync(file, "utf8")).toBe(contents);
  }
});

test("a symbolic-link state file never acquires access or overwrites its target", () => {
  const { root, file, input, store } = fixture();
  const target = join(root, "other.json");
  writeFileSync(target, "private bytes");
  symlinkSync(target, file);
  expect(() => store.list()).toThrow();
  expect(() => store.upsert(input)).toThrow();
  expect(readFileSync(target, "utf8")).toBe("private bytes");
});

test("returned records cannot mutate subsequent snapshots", () => {
  const { input, store } = fixture();
  const binding = store.upsert(input);
  binding.environmentId = randomUUID();
  const records = store.list();
  records[0].remoteProjectName = "mutated";
  const selection = store.setSelection(input.localProjectId, binding.id);
  selection.bindingId = null;
  expect(store.get(binding.id)?.environmentId).toBe(input.environmentId);
  expect(store.get(binding.id)?.remoteProjectName).toBe(input.remoteProjectName);
  expect(store.getSelection(input.localProjectId).bindingId).toBe(binding.id);
});
