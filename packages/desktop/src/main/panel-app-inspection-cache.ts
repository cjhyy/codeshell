import { lstat, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { InstalledPanelApp } from "@cjhyy/code-shell-core";

interface Snapshot {
  root: string;
  entries: Map<string, string>;
}

async function identity(path: string): Promise<string> {
  const info = await lstat(path, { bigint: true });
  if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory()))
    throw new Error("Installed Panel App contains an unsafe file");
  // ctime catches same-size in-place writes even if a writer restores mtime.
  return [info.dev, info.ino, info.mode, info.size, info.mtimeNs, info.ctimeNs].join(":");
}

async function snapshot(root: string, registryPath: string): Promise<Snapshot> {
  if ((await realpath(root)) !== root) throw new Error("Installed Panel App path changed");
  const entries = new Map<string, string>([[registryPath, await identity(registryPath)]]);
  const visit = async (path: string, depth: number) => {
    if (depth > 17 || entries.size > 2002) throw new Error("Installed Panel App is too large");
    entries.set(path, await identity(path));
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await visit(child, depth + 1);
      else {
        if (entries.size > 2002) throw new Error("Installed Panel App is too large");
        entries.set(child, await identity(child));
      }
    }
  };
  await visit(root, 0);
  return { root, entries };
}

async function unchanged(value: Snapshot): Promise<boolean> {
  try {
    if ((await realpath(value.root)) !== value.root) return false;
    const entries = [...value.entries];
    // Keep filesystem work bounded even for the largest accepted package.
    for (let offset = 0; offset < entries.length; offset += 32) {
      const same = await Promise.all(
        entries.slice(offset, offset + 32).map(async ([path, expected]) => {
          return (await identity(path)) === expected;
        }),
      );
      if (same.some((match) => !match)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Reuse a full package inspection only while every file, directory and registry
 * identity is unchanged. This is not a timed authorization cache: callers still
 * check current workspace trust, bindings and revision on every operation.
 * Native launch also retains its independent entry hash verification.
 */
export class PanelAppInspectionCache {
  private readonly entries = new Map<string, { app: InstalledPanelApp; snapshot: Snapshot }>();
  private readonly pending = new Map<string, Promise<InstalledPanelApp | undefined>>();

  constructor(
    private readonly options: {
      installPath(id: string): string;
      registryPath(): string;
      listInstalled(): Promise<InstalledPanelApp[]>;
    },
  ) {}

  async get(id: string): Promise<InstalledPanelApp | undefined> {
    const cached = this.entries.get(id);
    if (cached && (await unchanged(cached.snapshot))) return cached.app;
    this.entries.delete(id);
    let pending = this.pending.get(id);
    if (!pending) {
      pending = this.inspect(id).finally(() => this.pending.delete(id));
      this.pending.set(id, pending);
    }
    return pending;
  }

  private async inspect(id: string): Promise<InstalledPanelApp | undefined> {
    // Take the identity snapshot BEFORE inspection, then verify it afterwards:
    // a replacement during inspection must never become a trusted cache entry.
    let before: Snapshot;
    try {
      before = await snapshot(this.options.installPath(id), this.options.registryPath());
    } catch {
      return undefined;
    }
    const app = (await this.options.listInstalled()).find((candidate) => candidate.id === id);
    if (!app || app.installPath !== before.root || !(await unchanged(before))) return undefined;
    if (this.entries.size >= 32) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(id, { app, snapshot: before });
    return app;
  }
}
