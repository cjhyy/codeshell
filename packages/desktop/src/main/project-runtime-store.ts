import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { acquireFileLock } from "@cjhyy/code-shell-core/internal";
import type {
  CloudBindingInput,
  CloudProjectBinding,
  ProjectRuntimeSelection,
} from "../shared/project-runtime.js";

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_BINDINGS = 5_000;
const MAX_SELECTIONS = 5_000;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const INPUT_FIELDS = [
  "localProjectId",
  "origin",
  "environmentId",
  "environmentName",
  "remoteProjectId",
  "remoteProjectName",
] as const;

interface RuntimeSnapshot {
  version: 1;
  bindings: CloudProjectBinding[];
  selections: ProjectRuntimeSelection[];
}

/**
 * Main-owned, credential-free project associations and runtime preferences.
 * Reload inside the directory lock for every operation, including across app processes.
 * Corrupt state stays untouched and blocks reads and writes until explicitly repaired.
 */
export class ProjectRuntimeStore {
  constructor(private readonly filePath: string) {}

  list(localProjectId?: string): CloudProjectBinding[] {
    if (localProjectId !== undefined) checkedId(localProjectId);
    return this.access((snapshot) => ({
      result: snapshot.bindings.filter(
        (binding) => localProjectId === undefined || binding.localProjectId === localProjectId,
      ),
    }));
  }

  get(bindingId: string): CloudProjectBinding | undefined {
    checkedId(bindingId);
    return this.access((snapshot) => ({
      result: snapshot.bindings.find((binding) => binding.id === bindingId),
    }));
  }

  upsert(input: CloudBindingInput): CloudProjectBinding {
    const validated = checkedInput(input);
    return this.access((snapshot) => {
      if (
        snapshot.bindings.some(
          (binding) =>
            binding.origin === validated.origin &&
            binding.environmentId !== validated.environmentId,
        )
      ) {
        throw new Error("云端地址的环境身份已变化，请先核对并移除旧关联。");
      }
      const existing = snapshot.bindings.find((binding) => sameTarget(binding, validated));
      if (existing) {
        if (INPUT_FIELDS.every((field) => existing[field] === validated[field])) {
          return { result: existing };
        }
        Object.assign(existing, validated, { updatedAt: Math.max(Date.now(), existing.updatedAt) });
        return { result: existing, changed: true };
      }
      if (snapshot.bindings.length >= MAX_BINDINGS) throw new Error("云端项目关联数量已达上限。");
      const now = Date.now();
      const binding = { ...validated, id: randomUUID(), createdAt: now, updatedAt: now };
      snapshot.bindings.push(binding);
      return { result: binding, changed: true };
    });
  }

  remove(bindingId: string): void {
    checkedId(bindingId);
    this.access((snapshot) => {
      const index = snapshot.bindings.findIndex((binding) => binding.id === bindingId);
      if (index < 0) return { result: undefined };
      snapshot.bindings.splice(index, 1);
      for (const selection of snapshot.selections) {
        if (selection.bindingId === bindingId) selection.bindingId = null;
      }
      return { result: undefined, changed: true };
    });
  }

  getSelection(localProjectId: string): ProjectRuntimeSelection {
    checkedId(localProjectId);
    return this.access((snapshot) => ({
      result: snapshot.selections.find(
        (selection) => selection.localProjectId === localProjectId,
      ) ?? {
        localProjectId,
        bindingId: null,
      },
    }));
  }

  setSelection(localProjectId: string, bindingId: string | null): ProjectRuntimeSelection {
    checkedId(localProjectId);
    if (bindingId !== null) checkedId(bindingId);
    return this.access((snapshot) => {
      if (
        bindingId !== null &&
        !snapshot.bindings.some(
          (binding) => binding.id === bindingId && binding.localProjectId === localProjectId,
        )
      ) {
        throw new Error("运行位置必须属于当前本地项目。");
      }
      const existing = snapshot.selections.find(
        (selection) => selection.localProjectId === localProjectId,
      );
      if (existing?.bindingId === bindingId) return { result: existing };
      if (existing) {
        existing.bindingId = bindingId;
        return { result: existing, changed: true };
      }
      if (snapshot.selections.length >= MAX_SELECTIONS)
        throw new Error("项目运行位置数量已达上限。");
      const selection = { localProjectId, bindingId };
      snapshot.selections.push(selection);
      return { result: selection, changed: true };
    });
  }

  private access<T>(operation: (snapshot: RuntimeSnapshot) => { result: T; changed?: boolean }): T {
    const parent = dirname(this.filePath);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const directory = lstatSync(parent);
    if (directory.isSymbolicLink() || !directory.isDirectory()) {
      throw new Error("项目运行位置存储目录无效。");
    }
    const release = acquireFileLock(this.filePath);
    try {
      const snapshot = readSnapshot(this.filePath);
      const { result, changed } = operation(snapshot);
      if (changed) writeSnapshot(this.filePath, snapshot);
      return structuredClone(result);
    } finally {
      release();
    }
  }
}

function checkedObject(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("项目运行位置记录格式无效。");
  }
  const prototype = Object.getPrototypeOf(value);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    Object.keys(value).some((key) => !fields.includes(key))
  ) {
    throw new Error("项目运行位置记录含有无效字段。");
  }
  return value as Record<string, unknown>;
}

function checkedId(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new Error("项目或环境标识无效。");
  return value;
}

function checkedName(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 128 ||
    !value.trim() ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error("云端环境或项目名称无效。");
  }
  return value.trim();
}

function checkedOrigin(value: unknown): string {
  if (typeof value !== "string" || value.length > 2_048 || /[\u0000-\u0020\u007f\\]/.test(value)) {
    throw new Error("云端服务地址无效。");
  }
  const url = new URL(value);
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("请使用 HTTPS 服务源地址；本机测试可使用回环 HTTP 地址。");
  }
  return url.origin;
}

function checkedInput(value: unknown): CloudBindingInput {
  const raw = checkedObject(value, INPUT_FIELDS);
  return {
    localProjectId: checkedId(raw.localProjectId),
    origin: checkedOrigin(raw.origin),
    environmentId: checkedId(raw.environmentId),
    environmentName: checkedName(raw.environmentName),
    remoteProjectId: checkedId(raw.remoteProjectId),
    remoteProjectName: checkedName(raw.remoteProjectName),
  };
}

function sameTarget(left: CloudBindingInput, right: CloudBindingInput): boolean {
  return (
    left.localProjectId === right.localProjectId &&
    left.environmentId === right.environmentId &&
    left.remoteProjectId === right.remoteProjectId
  );
}

function checkedSnapshot(value: unknown): RuntimeSnapshot {
  const raw = checkedObject(value, ["version", "bindings", "selections"]);
  if (
    raw.version !== 1 ||
    !Array.isArray(raw.bindings) ||
    raw.bindings.length > MAX_BINDINGS ||
    !Array.isArray(raw.selections) ||
    raw.selections.length > MAX_SELECTIONS
  ) {
    throw new Error("项目运行位置存储版本或大小无效。");
  }
  const ids = new Set<string>();
  const targets = new Set<string>();
  const environments = new Map<string, string>();
  const bindings: CloudProjectBinding[] = raw.bindings.map((value) => {
    const item = checkedObject(value, [...INPUT_FIELDS, "id", "createdAt", "updatedAt"]);
    const input = checkedInput(Object.fromEntries(INPUT_FIELDS.map((key) => [key, item[key]])));
    if (
      item.origin !== input.origin ||
      item.environmentName !== input.environmentName ||
      item.remoteProjectName !== input.remoteProjectName ||
      !Number.isSafeInteger(item.createdAt) ||
      !Number.isSafeInteger(item.updatedAt) ||
      Number(item.createdAt) < 0 ||
      Number(item.updatedAt) < Number(item.createdAt)
    ) {
      throw new Error("云端项目关联存储无效。");
    }
    const id = checkedId(item.id);
    const target = JSON.stringify([
      input.localProjectId,
      input.environmentId,
      input.remoteProjectId,
    ]);
    const environment = environments.get(input.origin);
    if (
      ids.has(id) ||
      targets.has(target) ||
      (environment && environment !== input.environmentId)
    ) {
      throw new Error("云端项目关联身份冲突。");
    }
    ids.add(id);
    targets.add(target);
    environments.set(input.origin, input.environmentId);
    return { ...input, id, createdAt: Number(item.createdAt), updatedAt: Number(item.updatedAt) };
  });
  const selectedProjects = new Set<string>();
  const selections: ProjectRuntimeSelection[] = raw.selections.map((value) => {
    const item = checkedObject(value, ["localProjectId", "bindingId"]);
    const localProjectId = checkedId(item.localProjectId);
    const bindingId = item.bindingId === null ? null : checkedId(item.bindingId);
    if (
      selectedProjects.has(localProjectId) ||
      (bindingId !== null &&
        !bindings.some(
          (binding) => binding.id === bindingId && binding.localProjectId === localProjectId,
        ))
    ) {
      throw new Error("项目运行位置关联无效。");
    }
    selectedProjects.add(localProjectId);
    return { localProjectId, bindingId };
  });
  return { version: 1, bindings, selections };
}

function readSnapshot(filePath: string): RuntimeSnapshot {
  let metadata;
  try {
    metadata = lstatSync(filePath);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, bindings: [], selections: [] };
    }
    throw cause;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > MAX_BYTES) {
    throw new Error("项目运行位置存储必须是有界的普通文件。");
  }
  const descriptor = openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.size > MAX_BYTES ||
      opened.ino !== metadata.ino ||
      opened.dev !== metadata.dev
    ) {
      throw new Error("项目运行位置存储在读取时发生变化。");
    }
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(descriptor, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > MAX_BYTES) throw new Error("项目运行位置存储过大。");
    return checkedSnapshot(JSON.parse(bytes.subarray(0, length).toString("utf8")));
  } finally {
    closeSync(descriptor);
  }
}

function writeSnapshot(filePath: string, snapshot: RuntimeSnapshot): void {
  const contents = `${JSON.stringify(snapshot, null, 2)}\n`;
  if (Buffer.byteLength(contents, "utf8") > MAX_BYTES) throw new Error("项目运行位置存储过大。");
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const descriptor = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(descriptor, contents, "utf8");
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, filePath);
    if (process.platform !== "win32") {
      const directory = openSync(dirname(filePath), constants.O_RDONLY);
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    }
  } finally {
    rmSync(temporary, { force: true });
  }
}
