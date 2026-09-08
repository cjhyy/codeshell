import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  opendir,
  realpath,
  rename,
  rm,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import { acquireLockOnPath } from "@cjhyy/code-shell-core/internal";
import {
  DEFAULT_PANEL_APP_STORAGE_QUOTA_BYTES,
  panelAppStorageKey,
  panelAppStoragePath,
  preparePanelAppStorage,
  readPanelAppStorage,
  writePanelAppStorage,
} from "./storage-store.js";

const MAX_READ_BYTES = 480 * 1024;
const MAX_WRITE_BYTES = 384 * 1024;
const MAX_LIST_ENTRIES = 200;
const TEXT_EXTENSIONS = new Set([
  ".css",
  ".csv",
  ".html",
  ".json",
  ".md",
  ".svg",
  ".tsv",
  ".txt",
  ".yaml",
  ".yml",
]);
const METHOD_PERMISSIONS: Record<string, string> = {
  "storage.get": "storage",
  "storage.set": "storage",
  "storage.delete": "storage",
  "workspace.info": "workspace.info",
  "workspace.list": "workspace.read",
  "workspace.readText": "workspace.read",
  "workspace.writeText": "workspace.write",
};

export interface PanelRuntimeScope {
  appId: string;
  cwd: string;
  projectPath: string;
  permissions: readonly string[];
  /** Checks the live owner, its project binding, and the installed revision. */
  isAuthorized: () => Promise<boolean>;
}

type Identity = { dev: number; ino: number };
const writeQueues = new Map<string, Promise<void>>();

function revision(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function allowedSegment(segment: string): boolean {
  return (
    Boolean(segment) &&
    segment !== "." &&
    segment !== ".." &&
    !segment.startsWith(".") &&
    segment.toLowerCase() !== "node_modules" &&
    !/[\\:\u0000-\u001f\u007f]/u.test(segment) &&
    !/[. ]$/u.test(segment) &&
    !/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/iu.test(segment.split(".", 1)[0]!.trimEnd())
  );
}

function relativePath(params: unknown, allowRoot = false): string {
  const path = (params as { path?: unknown } | null)?.path;
  if (allowRoot && (path === undefined || path === "" || path === ".")) return ".";
  if (
    typeof path !== "string" ||
    !path ||
    path.length > 512 ||
    isAbsolute(path) ||
    !path.split("/").every(allowedSegment)
  )
    throw new Error("workspace path must be a safe relative path");
  return path;
}

function requireText(path: string): void {
  if (!TEXT_EXTENSIONS.has(extname(path).toLowerCase())) {
    throw new Error("workspace file type is not allowed");
  }
}

async function authorized(scope: PanelRuntimeScope): Promise<void> {
  if (!(await scope.isAuthorized())) throw new Error("Panel App owner is no longer authorized");
}

async function queued<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const pending = new Promise<void>((resolveQueue) => {
    release = resolveQueue;
  });
  const tail = previous.then(() => pending);
  writeQueues.set(key, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (writeQueues.get(key) === tail) writeQueues.delete(key);
  }
}

/** Share Desktop's per-file lock without blocking the Node event loop during contention. */
async function storageLock(file: string): Promise<() => void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      return acquireLockOnPath(file, -1);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ELOCKED" || Date.now() >= deadline)
        throw error;
      await new Promise((done) => setTimeout(done, 20));
    }
  }
}

/** Node-only implementation of the existing Panel SDK's bounded disk operations. */
export class PanelRuntimeServices {
  private readonly roots = new Map<string, { path: string; identity: Identity }>();
  private readonly dataDir: string;

  constructor(options: { dataDir: string }) {
    this.dataDir = resolve(options.dataDir);
  }

  async call(input: PanelRuntimeScope, method: string, params?: unknown): Promise<unknown> {
    if (
      !input ||
      !/^[a-z][a-z0-9-]{0,63}$/.test(input.appId) ||
      !input.cwd ||
      !input.projectPath ||
      !isAbsolute(input.cwd) ||
      !isAbsolute(input.projectPath) ||
      !Array.isArray(input.permissions) ||
      typeof input.isAuthorized !== "function"
    )
      throw new Error("Panel App scope is invalid");
    const scope = { ...input, permissions: [...input.permissions] };
    await authorized(scope);
    const permission = METHOD_PERMISSIONS[method];
    if (!permission) throw new Error(`Panel App method is unsupported by this host: ${method}`);
    if (!scope.permissions.includes(permission))
      throw new Error(`Panel App permission denied: ${permission}`);
    if (
      method.startsWith("workspace.") &&
      method !== "workspace.info" &&
      !scope.permissions.includes("context.workspace")
    ) {
      throw new Error("Panel App permission denied: context.workspace");
    }
    const result = method.startsWith("storage.")
      ? await this.storage(scope, method, params)
      : await this.workspace(scope, method, params);
    await authorized(scope);
    return result;
  }

  private async storage(
    scope: PanelRuntimeScope,
    method: string,
    params: unknown,
  ): Promise<unknown> {
    const key = panelAppStorageKey(params);
    const file = panelAppStoragePath(this.dataDir, scope.appId, scope.projectPath);
    const quota = DEFAULT_PANEL_APP_STORAGE_QUOTA_BYTES;
    if (method === "storage.get") {
      const state = await readPanelAppStorage(file, quota);
      return Object.hasOwn(state, key) ? state[key] : null;
    }
    const encoded =
      method === "storage.set" ? JSON.stringify((params as { value?: unknown })?.value) : null;
    if (method === "storage.set" && encoded === undefined)
      throw new Error("Panel App storage only accepts JSON values");
    return queued(file, async () => {
      await authorized(scope);
      await preparePanelAppStorage(file);
      const release = await storageLock(file);
      try {
        const state = await readPanelAppStorage(file, quota);
        const existed = Object.hasOwn(state, key);
        if (method === "storage.set") state[key] = JSON.parse(encoded!);
        else delete state[key];
        await writePanelAppStorage(file, state, quota, () => authorized(scope));
        return method === "storage.set" ? true : existed;
      } finally {
        release();
      }
    });
  }

  private async root(scope: PanelRuntimeScope): Promise<string> {
    const lexical = resolve(scope.cwd);
    const metadata = await lstat(lexical);
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
      throw new Error("workspace root is unavailable");
    const path = await realpath(lexical);
    const previous = this.roots.get(lexical);
    if (
      previous &&
      (previous.path !== path ||
        previous.identity.dev !== metadata.dev ||
        previous.identity.ino !== metadata.ino)
    ) {
      throw new Error("workspace root changed; reopen the panel");
    }
    this.roots.set(lexical, { path, identity: { dev: metadata.dev, ino: metadata.ino } });
    return path;
  }

  private async openPath(root: string, path: string, directory: boolean) {
    const held: Array<{ handle: FileHandle; path: string; identity: Identity }> = [];
    const parts = path === "." ? [] : path.split("/");
    const close = async () => {
      await Promise.all(held.map(({ handle }) => handle.close().catch(() => {})));
    };
    try {
      let current = root;
      for (let index = -1; index < parts.length; index++) {
        if (index >= 0) current = join(current, parts[index]!);
        const parent = held.at(-1);
        const location =
          process.platform === "linux" && parent
            ? `/proc/self/fd/${parent.handle.fd}/${parts[index]}`
            : current;
        const isDirectory = index < parts.length - 1 || directory;
        const handle = await open(
          location,
          constants.O_RDONLY |
            (constants.O_NOFOLLOW ?? 0) |
            (constants.O_NONBLOCK ?? 0) |
            (isDirectory ? (constants.O_DIRECTORY ?? 0) : 0),
        );
        const metadata = await handle.stat().catch(async (error) => {
          await handle.close();
          throw error;
        });
        held.push({ handle, path: current, identity: { dev: metadata.dev, ino: metadata.ino } });
        if (isDirectory ? !metadata.isDirectory() : !metadata.isFile())
          throw new Error("workspace path must be a regular file or directory");
      }
      const verify = async () => {
        for (const entry of held) {
          const actual = await lstat(entry.path);
          if (
            actual.isSymbolicLink() ||
            actual.dev !== entry.identity.dev ||
            actual.ino !== entry.identity.ino
          ) {
            throw new Error("workspace path changed while the panel was accessing it");
          }
        }
      };
      await verify();
      const handle = held.at(-1)!.handle;
      return {
        handle,
        verify,
        close,
        path: process.platform === "linux" ? `/proc/self/fd/${handle.fd}` : current,
      };
    } catch (error) {
      await close();
      throw error;
    }
  }

  private async read(handle: FileHandle): Promise<{ bytes: Buffer; metadata: Stats }> {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > MAX_READ_BYTES)
      throw new Error("workspace file is too large or is not a regular file");
    const bytes = Buffer.allocUnsafe(MAX_READ_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const chunk = await handle.read(bytes, length, bytes.length - length, length);
      if (!chunk.bytesRead) break;
      length += chunk.bytesRead;
    }
    if (length > MAX_READ_BYTES) throw new Error("workspace file is too large");
    return { bytes: bytes.subarray(0, length), metadata };
  }

  private async workspace(
    scope: PanelRuntimeScope,
    method: string,
    params: unknown,
  ): Promise<unknown> {
    const root = await this.root(scope);
    if (method === "workspace.info") {
      let gitBranch: string | null = null;
      try {
        const git = await this.openPath(root, ".git/HEAD", false);
        try {
          const { bytes } = await this.read(git.handle);
          if (bytes.length <= 4096) {
            const name = /^ref: refs\/heads\/(.+)$/m.exec(bytes.toString("utf8").trim())?.[1];
            if (name && name.length <= 255 && !/[\u0000-\u001f\u007f]/u.test(name))
              gitBranch = name;
          }
          await git.verify();
        } finally {
          await git.close();
        }
      } catch {
        /* Git metadata is optional, and never exposed as file content. */
      }
      await this.root(scope);
      return { name: basename(scope.cwd), root: scope.cwd, trusted: true, gitBranch };
    }
    const path = relativePath(params, method === "workspace.list");
    if (method === "workspace.writeText") return this.write(scope, root, path, params);
    if (method === "workspace.readText") requireText(path);
    let opened: Awaited<ReturnType<PanelRuntimeServices["openPath"]>>;
    try {
      opened = await this.openPath(root, path, method === "workspace.list");
    } catch (error) {
      if (method === "workspace.list" && (error as NodeJS.ErrnoException).code === "ENOENT")
        return { path, entries: [], truncated: false };
      throw error;
    }
    try {
      if (method === "workspace.readText") {
        const { bytes, metadata } = await this.read(opened.handle);
        const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        await opened.verify();
        await this.root(scope);
        return {
          path,
          content,
          size: bytes.length,
          modifiedAt: metadata.mtimeMs,
          revision: revision(bytes),
        };
      }
      const entries: Array<{
        name: string;
        path: string;
        kind: "file" | "directory";
        size?: number;
        modifiedAt?: number;
      }> = [];
      let examined = 0,
        truncated = false;
      const listing = await opendir(opened.path);
      for await (const entry of listing) {
        if (++examined > 4096) {
          truncated = true;
          break;
        }
        if (!allowedSegment(entry.name) || entry.isSymbolicLink()) continue;
        const child = path === "." ? entry.name : `${path}/${entry.name}`;
        if (
          child.length > 512 ||
          (!entry.isDirectory() && !TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase()))
        )
          continue;
        const metadata = await lstat(join(opened.path, entry.name)).catch(() => null);
        if (
          !metadata ||
          metadata.isSymbolicLink() ||
          (!metadata.isDirectory() && !metadata.isFile())
        )
          continue;
        if (entries.length >= MAX_LIST_ENTRIES) {
          truncated = true;
          break;
        }
        entries.push({
          name: entry.name,
          path: child,
          kind: metadata.isDirectory() ? "directory" : "file",
          ...(metadata.isFile() ? { size: metadata.size, modifiedAt: metadata.mtimeMs } : {}),
        });
      }
      entries.sort((left, right) => left.name.localeCompare(right.name));
      await opened.verify();
      await this.root(scope);
      return { path, entries, truncated };
    } finally {
      await opened.close();
    }
  }

  private async ensureDirectory(root: string, path: string): Promise<void> {
    let current = root;
    for (const segment of path === "." ? [] : path.split("/")) {
      current = join(current, segment);
      try {
        await mkdir(current, { mode: 0o755 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const metadata = await lstat(current);
      if (
        !metadata.isDirectory() ||
        metadata.isSymbolicLink() ||
        !(await realpath(current)).startsWith(`${root}${sep}`)
      ) {
        throw new Error("workspace path contains an unsafe directory");
      }
    }
  }

  private async write(
    scope: PanelRuntimeScope,
    root: string,
    path: string,
    params: unknown,
  ): Promise<unknown> {
    requireText(path);
    const { content, expectedModifiedAt, expectedRevision } = (params ?? {}) as Record<
      string,
      unknown
    >;
    if (typeof content !== "string" || Buffer.byteLength(content) > MAX_WRITE_BYTES)
      throw new Error(`workspace text must be at most ${MAX_WRITE_BYTES} bytes`);
    if (
      expectedModifiedAt !== undefined &&
      expectedModifiedAt !== null &&
      (typeof expectedModifiedAt !== "number" || !Number.isFinite(expectedModifiedAt))
    )
      throw new Error("expectedModifiedAt must be a number, null, or omitted");
    if (
      expectedRevision !== undefined &&
      (typeof expectedRevision !== "string" || !/^sha256:[0-9a-f]{64}$/.test(expectedRevision))
    )
      throw new Error("expectedRevision must be a sha256 revision or omitted");
    if (expectedRevision === undefined && expectedModifiedAt === undefined)
      throw new Error(
        "workspace.writeText requires expectedModifiedAt or expectedRevision to prevent blind overwrites",
      );
    const target = join(root, path);
    return queued(target, async () => {
      await authorized(scope);
      await this.root(scope);
      await this.ensureDirectory(root, dirname(path));
      const parent = await this.openPath(root, dirname(path), true);
      const stableTarget = join(parent.path, basename(path));
      const temporary = join(parent.path, `.${basename(path)}.${randomUUID()}.tmp`);
      try {
        let modifiedAt: number | null = null,
          currentRevision: string | null = null,
          mode = 0o644;
        let existing: Awaited<ReturnType<PanelRuntimeServices["openPath"]>> | undefined;
        try {
          existing = await this.openPath(root, path, false);
          const metadata = await existing.handle.stat();
          modifiedAt = metadata.mtimeMs;
          mode = metadata.mode & 0o777;
          if (expectedRevision !== undefined)
            currentRevision = revision((await this.read(existing.handle)).bytes);
          await existing.verify();
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        } finally {
          await existing?.close();
        }
        if (
          expectedRevision !== undefined
            ? currentRevision !== expectedRevision
            : expectedModifiedAt === null
              ? modifiedAt !== null
              : modifiedAt === null || Math.abs(modifiedAt - (expectedModifiedAt as number)) > 0.001
        ) {
          throw new Error("workspace file changed since it was opened");
        }
        const bytes = Buffer.from(content, "utf8");
        await writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
        await parent.verify();
        await this.root(scope);
        await authorized(scope);
        await parent.verify();
        // The owner check may await transport state. A user or another host
        // can edit the file during that await, so validate CAS again at commit.
        if (expectedRevision !== undefined || expectedModifiedAt !== null) {
          let finalTarget: Awaited<ReturnType<PanelRuntimeServices["openPath"]>> | undefined;
          try {
            finalTarget = await this.openPath(root, path, false);
            const finalMetadata = await finalTarget.handle.stat();
            const conflicts =
              expectedRevision !== undefined
                ? revision((await this.read(finalTarget.handle)).bytes) !== expectedRevision
                : Math.abs(finalMetadata.mtimeMs - (expectedModifiedAt as number)) > 0.001;
            if (conflicts) throw new Error("workspace file changed since it was opened");
            await finalTarget.verify();
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT")
              throw new Error("workspace file changed since it was opened", { cause: error });
            throw error;
          } finally {
            await finalTarget?.close();
          }
        }
        if (expectedModifiedAt === null && expectedRevision === undefined) {
          try {
            await link(temporary, stableTarget);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "EEXIST")
              throw new Error("workspace file changed since it was opened", { cause: error });
            throw error;
          }
        } else await rename(temporary, stableTarget);
        await chmod(stableTarget, mode).catch(() => {});
        const metadata = await lstat(stableTarget);
        return {
          path,
          size: bytes.length,
          modifiedAt: metadata.mtimeMs,
          revision: revision(bytes),
        };
      } finally {
        await rm(temporary, { force: true }).catch(() => {});
        await parent.close();
      }
    });
  }
}
