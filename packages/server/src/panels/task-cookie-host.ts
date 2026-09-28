import { randomBytes, randomUUID } from "node:crypto";
import { chmod, open, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { ToolJobStorage } from "./tool-jobs-storage.js";
import {
  PanelTaskCookieService,
  type PanelTaskCookieOptions,
  type TaskCookieScope,
  type TaskCookieSelection,
} from "./task-cookies.js";

/** One Host owns this private root. Stop its native tasks before shutdown. */
export class PanelTaskCookieHost {
  private readonly storage: ToolJobStorage;
  private initializing?: Promise<PanelTaskCookieService>;
  private closing?: Promise<void>;
  private stopped = false;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly leases = new Set<() => Promise<void>>();

  constructor(private readonly options: Omit<PanelTaskCookieOptions, "revisionKey">) {
    this.storage = new ToolJobStorage(options.rootDirectory);
  }
  private ready(): Promise<PanelTaskCookieService> {
    return (this.initializing ??= this.open());
  }
  private async open() {
    await this.storage.initialize();
    try {
      const root = await this.storage.directory();
      await chmod(root, 0o700);
      const keyPath = join(root, "revision-key.json");
      let record: unknown;
      try {
        record = await this.storage.read(keyPath, 1024);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        record = { version: 1, key: randomBytes(32).toString("hex") };
        const temporary = join(root, `${randomUUID()}.tmp`);
        try {
          const file = await open(temporary, "wx", 0o600);
          try {
            await file.writeFile(JSON.stringify(record));
            await file.sync();
          } finally {
            await file.close();
          }
          await this.storage.directory();
          await rename(temporary, keyPath);
          const parent = await open(root, "r");
          try {
            await parent.sync();
          } finally {
            await parent.close();
          }
        } finally {
          await rm(temporary, { force: true });
        }
      }
      const value = record as { version?: unknown; key?: unknown } | null;
      if (
        !value ||
        value.version !== 1 ||
        typeof value.key !== "string" ||
        !/^[a-f0-9]{64}$/.test(value.key)
      )
        throw new Error("Invalid task Cookie Host key");
      await chmod(keyPath, 0o600);
      // Ownership is exclusive, so these belong to an exited Host. Never sweep by age
      // while another Host can be running, and never touch unrelated root entries.
      for (const name of await readdir(root)) {
        if (/^cookies-[a-zA-Z0-9]{6}$/.test(name) || /^[a-f0-9-]{36}\.tmp$/.test(name)) {
          await this.storage.directory();
          await rm(join(root, name), { recursive: true, force: true });
        }
      }
      return new PanelTaskCookieService({
        ...this.options,
        rootDirectory: root,
        revisionKey: Buffer.from(value.key, "hex"),
        authorize: async (scope) => {
          if (this.stopped) throw new Error("Task Cookie Host is stopping");
          await this.storage.directory();
          await this.options.authorize(scope);
        },
      });
    } catch (error) {
      await this.storage.close();
      throw error;
    }
  }
  private run<T>(operation: (service: PanelTaskCookieService) => Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(new Error("Task Cookie Host is stopping"));
    const pending = this.ready().then((service) => {
      if (this.stopped) throw new Error("Task Cookie Host is stopping");
      return operation(service);
    });
    this.pending.add(pending);
    void pending.then(
      () => this.pending.delete(pending),
      () => this.pending.delete(pending),
    );
    return pending;
  }
  initialize(): Promise<void> {
    return this.run(async () => {});
  }
  list(scope: TaskCookieScope, url: string) {
    return this.run((service) => service.list(scope, url));
  }
  check(scope: TaskCookieScope, selection: TaskCookieSelection) {
    return this.run((service) => service.check(scope, selection));
  }
  materialize(scope: TaskCookieScope, selection: TaskCookieSelection) {
    return this.run(async (service) => {
      const lease = await service.materialize(scope, selection);
      if (this.stopped) {
        await lease.cleanup();
        throw new Error("Task Cookie Host is stopping");
      }
      const cleanup = async () => {
        await lease.cleanup();
        this.leases.delete(cleanup);
      };
      this.leases.add(cleanup);
      return { ...lease, cleanup };
    });
  }
  shutdown(): Promise<void> {
    this.stopped = true;
    return (this.closing ??= (async () => {
      if (!this.initializing) return;
      // open() releases ownership itself on initialization failure.
      const opened = await this.initializing.then(
        () => true,
        () => false,
      );
      await Promise.allSettled([...this.pending]);
      if (!opened) return;
      const results = await Promise.allSettled([...this.leases].map((cleanup) => cleanup()));
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (errors.length) throw new AggregateError(errors, "Task Cookie cleanup failed");
      await this.storage.close();
    })());
  }
}
