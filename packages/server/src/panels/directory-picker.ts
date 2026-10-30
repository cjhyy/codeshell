import { randomBytes } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { opendir } from "node:fs/promises";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { PanelManagementError } from "./management.js";
import { PanelBridgeError } from "./bridge-contract.js";

export const directoryPickerLifetime = 5 * 60_000;
const TOKEN = /^[A-Za-z0-9_-]{24}$/;
const MAX_TOKENS = 1024;
const MAX_ENTRIES = 200;
const MAX_SCAN = 4096;
const MAX_TOKEN_BYTES = 1024 * 1024;

interface Identity {
  path: string;
  dev: bigint;
  ino: bigint;
}
interface Choice {
  token: string;
  parts: string[];
  chain: Identity[];
  parentToken?: string;
}
export interface PanelDirectorySelection {
  path: string;
  assertCurrent(): void;
}

function unavailable(): never {
  throw new PanelManagementError(409, "panel_directory_picker", "目录选择已失效，请重新发起。");
}
function identity(path: string): Identity {
  try {
    const info = lstatSync(path, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(path) !== path) unavailable();
    return { path, dev: info.dev, ino: info.ino };
  } catch {
    return unavailable();
  }
}
function assertIdentity(expected: Identity) {
  const actual = identity(expected.path);
  if (actual.dev !== expected.dev || actual.ino !== expected.ino) unavailable();
}
function visibleName(name: string) {
  return (
    name.length > 0 &&
    name.length <= 255 &&
    !name.startsWith(".") &&
    !/[\\/\u0000-\u001f\u007f]/u.test(name)
  );
}

/** Used only after a Host bookmark proves a previous choice; a client path is never sufficient. */
export function capturePanelWorkspaceDirectory(cwd: string, path: string): PanelDirectorySelection {
  let root: string;
  try {
    root = realpathSync(cwd);
  } catch {
    return unavailable();
  }
  const rel = relative(root, path);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) unavailable();
  const parts = rel.split(sep).filter(Boolean);
  if (parts.length > 64) unavailable();
  const chain = [identity(root)];
  for (let i = 0; i < parts.length; i++) chain.push(identity(join(root, ...parts.slice(0, i + 1))));
  const assertCurrent = () => {
    try {
      if (realpathSync(cwd) !== root) unavailable();
    } catch {
      unavailable();
    }
    for (const entry of chain) assertIdentity(entry);
  };
  assertCurrent();
  return { path, assertCurrent };
}

/** A pending parent-UI choice of an existing project directory, not filesystem authority. */
export class PanelDirectoryPicker {
  readonly rootPath: string;
  readonly rootToken: string;
  readonly initialToken: string;
  readonly expiresAt: number;
  private readonly root: Identity;
  private readonly choices = new Map<string, Choice>();
  private closed = false;
  private reading = false;
  private tokenBytes = 0;

  constructor(
    private readonly cwd: string,
    private readonly now: () => number,
  ) {
    this.rootPath = realpathSync(cwd);
    this.root = identity(this.rootPath);
    this.expiresAt = now() + directoryPickerLifetime;
    this.rootToken = this.add([], [this.root]).token;
    const path = join(this.rootPath, "downloads");
    let child: Identity | undefined;
    try {
      child = identity(path);
    } catch (error) {
      if (
        !(error instanceof PanelManagementError) &&
        (error as NodeJS.ErrnoException).code !== "ENOENT"
      )
        throw error;
    }
    this.initialToken = child
      ? this.add(["downloads"], [this.root, child], this.rootToken).token
      : this.rootToken;
    this.assertCurrent();
  }

  close() {
    this.closed = true;
    this.choices.clear();
    this.tokenBytes = 0;
  }

  private assertRoot() {
    try {
      if (realpathSync(this.cwd) !== this.rootPath) unavailable();
    } catch {
      unavailable();
    }
    assertIdentity(this.root);
  }

  assertCurrent() {
    if (this.closed || this.now() >= this.expiresAt) unavailable();
    this.assertRoot();
  }

  private check(choice: Choice) {
    this.assertCurrent();
    for (const entry of choice.chain) assertIdentity(entry);
  }

  private get(token: unknown) {
    const choice = typeof token === "string" && TOKEN.test(token) && this.choices.get(token);
    if (!choice) unavailable();
    this.check(choice);
    return choice;
  }

  private add(parts: string[], chain: Identity[], parentToken?: string): Choice {
    const existing = [...this.choices.values()].find(
      (item) => item.parts.join("/") === parts.join("/"),
    );
    if (existing) {
      this.check(existing);
      return existing;
    }
    const bytes =
      Buffer.byteLength(join(this.rootPath, ...parts)) +
      Buffer.byteLength(parts.join("/")) +
      chain.length * 32 +
      256;
    if (
      this.choices.size >= MAX_TOKENS ||
      parts.length > 64 ||
      this.tokenBytes + bytes > MAX_TOKEN_BYTES
    )
      unavailable();
    const choice: Choice = {
      token: randomBytes(18).toString("base64url"),
      parts,
      chain,
      ...(parentToken ? { parentToken } : {}),
    };
    this.choices.set(choice.token, choice);
    this.tokenBytes += bytes;
    return choice;
  }

  async list(token: unknown, authorize: () => Promise<void>) {
    if (this.reading) throw new PanelBridgeError("RATE_LIMITED", "目录正在读取，请稍后重试。", 50);
    this.reading = true;
    try {
      const choice = this.get(token);
      await authorize();
      this.check(choice);
      const directories: Array<{ name: string; token: string }> = [];
      let truncated = false;
      {
        const directory = await opendir(join(this.rootPath, ...choice.parts));
        let scanned = 0;
        try {
          this.check(choice);
          for await (const entry of directory) {
            this.check(choice);
            if (++scanned > MAX_SCAN) {
              truncated = true;
              break;
            }
            if (!entry.isDirectory() || entry.isSymbolicLink() || !visibleName(entry.name))
              continue;
            if (directories.length >= MAX_ENTRIES) {
              truncated = true;
              break;
            }
            const parts = [...choice.parts, entry.name];
            const path = join(this.rootPath, ...parts);
            let child: Identity;
            try {
              child = identity(path);
            } catch {
              continue;
            }
            const item = this.add(parts, [...choice.chain, child], choice.token);
            directories.push({ name: entry.name, token: item.token });
          }
        } finally {
          // for-await closes its directory; the explicit close covers failure before iteration.
          try {
            await directory.close();
          } catch {
            /* Already closed by the iterator. */
          }
        }
      }
      await authorize();
      this.check(choice);
      for (const item of directories) this.get(item.token);
      return {
        directoryToken: choice.token,
        relativePath: choice.parts.join("/"),
        name: choice.parts.at(-1) ?? (basename(this.rootPath) || this.rootPath),
        ...(choice.parentToken ? { parentToken: choice.parentToken } : {}),
        rootToken: this.rootToken,
        directories: directories.sort((a, b) => a.name.localeCompare(b.name)),
        truncated,
      };
    } finally {
      this.reading = false;
    }
  }

  assertListing(listing: { directoryToken: string; directories: Array<{ token: string }> }) {
    this.get(listing.directoryToken);
    for (const item of listing.directories) this.get(item.token);
  }

  /** Called synchronously after final authorization, while this exact confirmation is pending. */
  select(token: unknown): PanelDirectorySelection {
    const choice = this.get(token);
    const path = join(this.rootPath, ...choice.parts);
    const chain = [...choice.chain];
    const assertCurrent = () => {
      this.assertRoot();
      for (const entry of chain) assertIdentity(entry);
    };
    assertCurrent();
    return { path, assertCurrent };
  }
}
