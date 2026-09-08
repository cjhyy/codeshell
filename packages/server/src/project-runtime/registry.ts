import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  constants,
  chmodSync,
  closeSync,
  existsSync,
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
import { join, resolve } from "node:path";
import { acquireProjectControllerLock, type ProjectControllerLock } from "./lock.js";
import type { ProjectRuntimeRecord } from "./types.js";

export type ProjectStatus = "stopped" | "starting" | "running" | "stopping" | "error";
export interface StoredProject extends ProjectRuntimeRecord {
  name: string;
  status: ProjectStatus;
  createdAt: number;
  updatedAt: number;
  error?: string;
}
export interface ProjectView {
  id: string;
  name: string;
  status: ProjectStatus;
  generation: number;
  createdAt: number;
  updatedAt: number;
  error?: string;
}
interface RegistryData {
  version: 1;
  installationId: string;
  owners: Array<{ id: string; username: string }>;
  projects: StoredProject[];
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const STATUSES = new Set(["stopped", "starting", "running", "stopping", "error"]);
const MAX_STORE_BYTES = 512 * 1024;
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function privateFileBytes(file: string, maximum = MAX_STORE_BYTES): Buffer {
  const entry = lstatSync(file);
  if (
    !entry.isFile() ||
    entry.isSymbolicLink() ||
    entry.nlink !== 1 ||
    entry.size > maximum ||
    entry.mode & 0o077
  )
    throw new Error("Project registry file must be a bounded private regular file.");
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    if (
      !opened.isFile() ||
      opened.ino !== entry.ino ||
      opened.dev !== entry.dev ||
      opened.nlink !== 1 ||
      opened.size > maximum
    )
      throw new Error("Project registry file changed while opening it.");
    const bytes = Buffer.alloc(maximum + 1);
    let size = 0;
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, size);
      if (!count) break;
      size += count;
    }
    if (size > maximum) throw new Error("Project registry file is too large.");
    return bytes.subarray(0, size);
  } finally {
    closeSync(fd);
  }
}

export class ProjectRegistryError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** The control plane owns identifiers and credentials; callers receive explicit public views. */
export class ProjectRegistry {
  private readonly directory: string;
  private readonly file: string;
  private readonly marker: string;
  private data!: RegistryData;
  private readonly controllerLock: ProjectControllerLock;
  private diskDigest: string | undefined;
  private markerEstablished = false;

  constructor(
    dataDir: string,
    private readonly now = Date.now,
    private readonly io: { rename?: typeof renameSync } = {},
  ) {
    this.directory = resolve(dataDir, "project-control");
    const existed = existsSync(this.directory);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const directory = lstatSync(this.directory);
    if (!directory.isDirectory() || directory.isSymbolicLink())
      throw new Error("Project registry must be a private directory");
    chmodSync(this.directory, 0o700);
    this.file = join(this.directory, "registry.json");
    this.marker = join(this.directory, "initialized");
    this.controllerLock = acquireProjectControllerLock(this.directory);
    try {
      if (existsSync(this.marker)) {
        if (privateFileBytes(this.marker, 16).toString() !== "1\n")
          throw new Error("Project initialization marker is corrupt.");
        this.markerEstablished = true;
      }
      if (existsSync(this.file)) {
        const bytes = privateFileBytes(this.file);
        this.data = JSON.parse(bytes.toString("utf8"));
        this.validate();
        this.diskDigest = digest(bytes);
      } else {
        if (existsSync(this.marker) || existed)
          throw new Error(
            "Project registry is missing; restore the existing registry before starting",
          );
        this.data = { version: 1, installationId: randomUUID(), owners: [], projects: [] };
        this.write();
      }
      if (!this.markerEstablished) {
        writeFileSync(this.marker, "1\n", { mode: 0o600, flag: "wx" });
        this.markerEstablished = true;
      }
    } catch (error) {
      this.controllerLock.release();
      throw error;
    }
  }

  /** Release the single-controller lease on shutdown or startup failure. */
  close(): void {
    this.controllerLock.release();
  }

  get installationId(): string {
    this.assertStorage();
    return this.data.installationId;
  }

  private validate(data = this.data): void {
    if (
      !data ||
      data.version !== 1 ||
      !UUID.test(data.installationId) ||
      !Array.isArray(data.owners) ||
      !Array.isArray(data.projects) ||
      data.owners.length > 128 ||
      data.projects.length > 128
    )
      throw new Error("Project registry is corrupt; restore its backup");
    const owners = new Set<string>();
    const names = new Set<string>();
    for (const owner of data.owners) {
      if (
        !owner ||
        !UUID.test(owner.id) ||
        typeof owner.username !== "string" ||
        !owner.username.trim() ||
        owner.username.length > 64 ||
        owner.username.trim() !== owner.username ||
        /[\x00-\x1f\x7f]/.test(owner.username) ||
        owners.has(owner.id) ||
        names.has(owner.username)
      )
        throw new Error("Project owner registry is corrupt");
      owners.add(owner.id);
      names.add(owner.username);
    }
    const ids = new Set<string>();
    for (const project of data.projects) {
      if (
        !project ||
        !UUID.test(project.id) ||
        ids.has(project.id) ||
        !owners.has(project.ownerId) ||
        typeof project.name !== "string" ||
        !project.name.trim() ||
        project.name.length > 80 ||
        project.name.trim() !== project.name ||
        /[\x00-\x1f\x7f]/.test(project.name) ||
        !STATUSES.has(project.status) ||
        !Number.isSafeInteger(project.generation) ||
        project.generation < 0 ||
        project.runtimeUsername !== "project-runtime" ||
        !TOKEN.test(project.runtimePassword) ||
        !Number.isSafeInteger(project.createdAt) ||
        project.createdAt < 0 ||
        !Number.isSafeInteger(project.updatedAt) ||
        project.updatedAt < project.createdAt ||
        (project.error !== undefined &&
          (typeof project.error !== "string" || project.error.length > 1000))
      )
        throw new Error("Project registry entry is corrupt");
      ids.add(project.id);
    }
  }

  private assertStorage(): void {
    this.controllerLock.assertHeld();
    if (this.markerEstablished && privateFileBytes(this.marker, 16).toString() !== "1\n")
      throw new Error("Project initialization marker changed.");
    if (this.diskDigest !== undefined) {
      if (digest(privateFileBytes(this.file)) !== this.diskDigest)
        throw new Error("Project registry changed while the controller was running.");
    } else if (existsSync(this.file)) throw new Error("Unexpected existing project registry.");
  }

  private write(next = this.data): void {
    this.validate(next);
    this.assertStorage();
    const bytes = Buffer.from(JSON.stringify(next, null, 2) + "\n");
    if (bytes.length > MAX_STORE_BYTES) throw new Error("Project registry is too large.");
    const file = join(this.directory, `.registry-${randomUUID()}.tmp`);
    let fd: number | undefined;
    try {
      fd = openSync(
        file,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      writeFileSync(fd, bytes);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      this.assertStorage();
      (this.io.rename ?? renameSync)(file, this.file);
      this.diskDigest = digest(bytes);
    } finally {
      if (fd !== undefined) closeSync(fd);
      rmSync(file, { force: true });
    }
  }

  all(): StoredProject[] {
    this.assertStorage();
    return this.data.projects.map((item) => ({ ...item }));
  }

  list(username: string): ProjectView[] {
    this.assertStorage();
    const owner = this.data.owners.find((item) => item.username === username);
    return this.data.projects.filter((item) => item.ownerId === owner?.id).map(projectView);
  }

  get(username: string, id: string): StoredProject {
    this.assertStorage();
    const owner = this.data.owners.find((item) => item.username === username);
    const project = this.data.projects.find((item) => item.id === id && item.ownerId === owner?.id);
    if (!project) throw new ProjectRegistryError(404, "找不到这个项目。");
    return { ...project };
  }

  create(username: string, name: unknown): StoredProject {
    this.assertStorage();
    if (
      typeof name !== "string" ||
      !name.trim() ||
      name.trim().length > 80 ||
      /[\x00-\x1f\x7f]/.test(name)
    )
      throw new ProjectRegistryError(400, "请输入 1 至 80 个字符的项目名称。");
    if (
      typeof username !== "string" ||
      !username ||
      username.trim() !== username ||
      username.length > 64 ||
      /[\x00-\x1f\x7f]/.test(username)
    )
      throw new ProjectRegistryError(401, "请先登录。");
    if (this.data.projects.length >= 32)
      throw new ProjectRegistryError(429, "项目数量已达到上限（32 个）。");
    const next = structuredClone(this.data);
    let owner = next.owners.find((item) => item.username === username);
    if (!owner) {
      owner = { id: randomUUID(), username };
      next.owners.push(owner);
    }
    const timestamp = this.now();
    const project: StoredProject = {
      id: randomUUID(),
      ownerId: owner.id,
      name: name.trim(),
      status: "stopped",
      generation: 0,
      runtimeUsername: "project-runtime",
      runtimePassword: randomBytes(32).toString("base64url"),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    next.projects.push(project);
    this.write(next);
    this.data = next;
    return { ...project };
  }

  update(
    id: string,
    patch: { status: ProjectStatus; generation?: number; error?: string },
  ): StoredProject {
    this.assertStorage();
    const index = this.data.projects.findIndex((item) => item.id === id);
    if (index === -1) throw new ProjectRegistryError(404, "找不到这个项目。");
    const previous = this.data.projects[index]!;
    const next: StoredProject = {
      ...previous,
      status: patch.status,
      updatedAt: Math.max(previous.updatedAt, this.now()),
      ...(patch.generation !== undefined ? { generation: patch.generation } : {}),
      ...(patch.error !== undefined ? { error: patch.error } : {}),
    };
    if (patch.error === undefined) delete next.error;
    if (next.generation < previous.generation || !Number.isSafeInteger(next.generation))
      throw new Error("Project generation cannot move backwards");
    const candidate = structuredClone(this.data);
    candidate.projects[index] = next;
    this.write(candidate);
    this.data = candidate;
    return { ...next };
  }
}

export function projectView(project: StoredProject): ProjectView {
  const error = project.error?.split(project.runtimePassword).join("[redacted]");
  return {
    id: project.id,
    name: project.name,
    status: project.status,
    generation: project.generation,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    ...(error ? { error } : {}),
  };
}
