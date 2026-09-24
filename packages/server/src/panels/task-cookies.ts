import { createHmac, timingSafeEqual } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  formatNetscapeCookies,
  parseCookieJar,
  type Credential,
  type CookieLike,
} from "@cjhyy/code-shell-core";

export interface TaskCookieScope {
  appId: string;
  projectPath: string;
  revision: string;
}
export interface TaskCookieSelection {
  credentialId: string;
  url: string;
  /** Opaque Host-keyed version, bound to the app, project and reviewed package. */
  revision: string;
}
export interface TaskCookieAccount {
  id: string;
  label: string;
  domain: string;
  revision: string;
}
export interface PanelTaskCookieOptions {
  /** Private Host directory, never a workspace or task artifact directory. */
  rootDirectory: string;
  /** At least 32 random bytes, persisted privately by the Host across restarts. */
  revisionKey: Uint8Array;
  /** Host trust, installed package, project binding and credentials.cookies permission. */
  authorize(scope: TaskCookieScope): Promise<void>;
  /** Host-owned vault adapter. Values must never cross the UI bridge. */
  credentials(scope: TaskCookieScope): Promise<Credential[]>;
  now?(): number;
}

function targetUrl(raw: unknown): URL {
  if (typeof raw !== "string" || raw.length > 2048)
    throw new Error("Cookie selection requires an HTTPS URL");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Cookie selection requires an HTTPS URL");
  }
  if (url.protocol !== "https:" || url.username || url.password || !url.hostname)
    throw new Error("Cookie selection requires an HTTPS URL");
  return url;
}
function domain(raw: unknown): string | undefined {
  if (typeof raw !== "string") return;
  const value = raw.toLowerCase().replace(/^\./, "");
  if (
    value.length > 253 ||
    !value.includes(".") ||
    !value.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  )
    return;
  return value;
}
function beneath(host: string, root: string) {
  return host === root || host.endsWith(`.${root}`);
}
export function taskCookieSelection(raw: unknown): TaskCookieSelection {
  if (
    !raw ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    Object.keys(raw).some((key) => !["credentialId", "url", "revision"].includes(key))
  )
    throw new Error("Invalid task Cookie selection");
  const input = raw as TaskCookieSelection;
  if (
    typeof input.credentialId !== "string" ||
    !input.credentialId.trim() ||
    input.credentialId.length > 160 ||
    /[\x00-\x1f\x7f]/.test(input.credentialId) ||
    typeof input.revision !== "string" ||
    !/^[a-f0-9]{64}$/.test(input.revision)
  )
    throw new Error("Invalid task Cookie selection");
  targetUrl(input.url);
  return { credentialId: input.credentialId, url: input.url, revision: input.revision };
}

/** Read only the selected credential reference from a native task envelope. */
export function taskCookieFromInput(raw: unknown): TaskCookieSelection | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
  const argument = (raw as { cookieArgument?: unknown }).cookieArgument;
  if (argument === undefined) return;
  if (!argument || typeof argument !== "object" || Array.isArray(argument))
    throw new Error("Invalid task Cookie argument");
  const { argumentName, ...selection } = argument as Record<string, unknown>;
  if (typeof argumentName !== "string" || !/^--[a-z][a-z0-9-]{0,63}$/.test(argumentName))
    throw new Error("Invalid task Cookie argument");
  return taskCookieSelection(selection);
}

/** Cookie custody only. Admission/retry consent belongs to the calling Host, not this vault. */
export class PanelTaskCookieService {
  private readonly key: Buffer;
  constructor(private readonly options: PanelTaskCookieOptions) {
    if (!(options.revisionKey instanceof Uint8Array) || options.revisionKey.byteLength < 32)
      throw new Error("Task Cookie revisions require a private Host key");
    if (!isAbsolute(options.rootDirectory)) throw new Error("Task Cookie root must be absolute");
    this.key = Buffer.from(options.revisionKey);
  }
  private version(scope: TaskCookieScope, credential: Credential, root: string) {
    return createHmac("sha256", this.key)
      .update(
        JSON.stringify([
          "codeshell-task-cookie-v1",
          scope.appId,
          scope.projectPath,
          scope.revision,
          credential.id,
          credential.label,
          root,
          credential.secret,
        ]),
      )
      .digest("hex");
  }
  private cookies(credential: Credential, root: string): CookieLike[] {
    const now = (this.options.now?.() ?? Date.now()) / 1000;
    if (
      typeof credential.secret !== "string" ||
      Buffer.byteLength(credential.secret) > 4 * 1024 * 1024
    )
      return [];
    const jar = parseCookieJar(credential.secret);
    if (jar.length > 10000) return [];
    return jar.filter((cookie) => {
      if (
        !cookie ||
        typeof cookie !== "object" ||
        typeof cookie.name !== "string" ||
        typeof cookie.value !== "string" ||
        !cookie.name ||
        /[\x00-\x1f\x7f]/.test(cookie.name + cookie.value) ||
        (cookie.path !== undefined &&
          (typeof cookie.path !== "string" ||
            !cookie.path.startsWith("/") ||
            /[\x00-\x1f\x7f]/.test(cookie.path)))
      )
        return false;
      const cookieDomain = domain(cookie.domain);
      if (!cookieDomain || !beneath(cookieDomain, root)) return false;
      if (
        cookie.expirationDate !== undefined &&
        (typeof cookie.expirationDate !== "number" ||
          !Number.isFinite(cookie.expirationDate) ||
          (cookie.expirationDate > 0 && cookie.expirationDate <= now))
      )
        return false;
      return true;
    });
  }
  private async snapshot(scope: TaskCookieScope, url: URL) {
    await this.options.authorize(scope);
    const result = (await this.options.credentials(scope)).flatMap((credential) => {
      const root = domain(credential.meta?.domain);
      if (credential.type !== "cookie" || !root || !beneath(url.hostname.toLowerCase(), root))
        return [];
      const cookies = this.cookies(credential, root);
      if (!cookies.length) return [];
      return [
        {
          account: {
            id: credential.id,
            label: credential.label,
            domain: root,
            revision: this.version(scope, credential, root),
          },
          cookies,
        },
      ];
    });
    await this.options.authorize(scope);
    return result;
  }
  async list(scope: TaskCookieScope, url: string): Promise<{ accounts: TaskCookieAccount[] }> {
    return { accounts: (await this.snapshot(scope, targetUrl(url))).map((item) => item.account) };
  }
  private async selected(scope: TaskCookieScope, raw: TaskCookieSelection) {
    const input = taskCookieSelection(raw);
    const matches = (await this.snapshot(scope, targetUrl(input.url))).filter(
      (item) => item.account.id === input.credentialId,
    );
    const item = matches.length === 1 ? matches[0] : undefined;
    if (
      !item ||
      !timingSafeEqual(
        Buffer.from(item.account.revision, "hex"),
        Buffer.from(input.revision, "hex"),
      )
    )
      throw new Error(
        "Selected Cookie login changed or is unavailable; select and authorize it again",
      );
    return item;
  }
  async check(scope: TaskCookieScope, selection: TaskCookieSelection): Promise<TaskCookieAccount> {
    return (await this.selected(scope, selection)).account;
  }
  async materialize(scope: TaskCookieScope, selection: TaskCookieSelection) {
    const { cookies } = await this.selected(scope, selection);
    const root = this.options.rootDirectory;
    await mkdir(root, { recursive: true, mode: 0o700 });
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Invalid task Cookie root");
    await chmod(root, 0o700);
    const directory = await mkdtemp(join(await realpath(root), "cookies-"));
    await chmod(directory, 0o700);
    const path = join(directory, "cookies.txt");
    let cleaning: Promise<void> | undefined;
    const cleanup = () => (cleaning ??= rm(directory, { recursive: true, force: true }));
    try {
      await writeFile(path, formatNetscapeCookies(cookies), { mode: 0o600, flag: "wx" });
      // Recheck after asynchronous filesystem work, before releasing a secret to the program.
      await this.check(scope, selection);
      return { path, count: cookies.length, cleanup };
    } catch (error) {
      await cleanup();
      throw error;
    }
  }
}
