import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import {
  credentialAllowsEnvExposure,
  credentialSecretHint,
  type Credential,
  type CredentialStoreFile,
} from "./types.js";
import { type EncryptionCipher, getDefaultCredentialCipher } from "./cipher.js";
import { logger } from "../logging/logger.js";
import { summarizeOAuthCredentialSecret } from "./oauth.js";
import { isBrowserOAuthLinkCredential } from "./oauth.js";
import { acquireFileLock, writeFileAtomic } from "../utils/file-mutex.js";

const MAX_CREDENTIALS = 4_096;
const MAX_CREDENTIAL_FILE_BYTES = 32 * 1024 * 1024;
const MAX_CREDENTIAL_SECRET_BYTES = 16 * 1024 * 1024;
const MAX_CREDENTIAL_META_BYTES = 1024 * 1024;
const MAX_CREDENTIAL_ID_CHARS = 512;
const MAX_CREDENTIAL_LABEL_CHARS = 4_096;

function normalizeCredential(value: unknown, strict: boolean): Credential | undefined {
  const invalid = (message: string): undefined => {
    if (strict) throw new Error(`invalid credential: ${message}`);
    return undefined;
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid("object");
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.id !== "string" ||
    !raw.id ||
    raw.id.length > MAX_CREDENTIAL_ID_CHARS ||
    raw.id.includes("\0")
  ) {
    return invalid("id");
  }
  if (
    raw.type !== "token" &&
    raw.type !== "link" &&
    raw.type !== "cookie" &&
    raw.type !== "oauth"
  ) {
    return invalid("type");
  }
  if (
    typeof raw.label !== "string" ||
    raw.label.length > MAX_CREDENTIAL_LABEL_CHARS ||
    raw.label.includes("\0")
  ) {
    return invalid("label");
  }
  if (
    raw.secret !== undefined &&
    (typeof raw.secret !== "string" || Buffer.byteLength(raw.secret) > MAX_CREDENTIAL_SECRET_BYTES)
  ) {
    return invalid("secret");
  }
  if (
    raw.exposeAsEnv !== undefined &&
    (typeof raw.exposeAsEnv !== "string" ||
      raw.exposeAsEnv.length > 512 ||
      raw.exposeAsEnv.includes("\0"))
  ) {
    return invalid("exposeAsEnv");
  }
  if (raw.autoUseByAI !== undefined && typeof raw.autoUseByAI !== "boolean") {
    return invalid("autoUseByAI");
  }
  if (raw.autoInjectByAI !== undefined && typeof raw.autoInjectByAI !== "boolean") {
    return invalid("autoInjectByAI");
  }

  let meta: Credential["meta"];
  if (raw.meta !== undefined) {
    if (!raw.meta || typeof raw.meta !== "object" || Array.isArray(raw.meta)) {
      return invalid("meta");
    }
    try {
      const encoded = JSON.stringify(raw.meta);
      if (Buffer.byteLength(encoded) > MAX_CREDENTIAL_META_BYTES) return invalid("meta");
      // Clone through JSON so callers cannot retain a mutable/cyclic object or
      // smuggle a surprising prototype into later credential consumers.
      meta = JSON.parse(encoded) as Credential["meta"];
    } catch {
      return invalid("meta");
    }
  }

  return {
    id: raw.id,
    type: raw.type,
    label: raw.label,
    ...(typeof raw.secret === "string" ? { secret: raw.secret } : {}),
    ...(typeof raw.exposeAsEnv === "string" ? { exposeAsEnv: raw.exposeAsEnv } : {}),
    ...(typeof raw.autoUseByAI === "boolean" ? { autoUseByAI: raw.autoUseByAI } : {}),
    ...(typeof raw.autoInjectByAI === "boolean" ? { autoInjectByAI: raw.autoInjectByAI } : {}),
    ...(meta ? { meta } : {}),
  };
}

/** 测试可经 process.env.HOME 覆盖(镜像 settings/manager.ts userHome)。 */
function userHome(): string {
  return process.env.HOME ?? homedir();
}

export type CredentialScope = "user" | "project";

export interface MaskedCredential extends Omit<Credential, "secret"> {
  hasSecret: boolean;
  /** 形如 `****abcd`,绝不含完整明文。 */
  secretHint?: string;
  oauthStatus?: import("./types.js").OAuthCredentialPublicStatus;
}

const EMPTY: CredentialStoreFile = { version: 1, credentials: [] };

/**
 * 两层凭证库,镜像 SettingsManager 的 user(~/.code-shell)/ project(<cwd>/.code-shell)
 * 双层模型。只存 token / link;cookie 不进库(见 credentials-module 设计稿)。
 */
export class CredentialStore {
  private readonly cipher: EncryptionCipher;

  /**
   * @param cwd     project root for the project-scope store (undefined → user only).
   * @param cipher  secret encryption strategy. Defaults to the process-wide
   *                cipher (see setDefaultCredentialCipher) — PlaintextCipher
   *                unless the host installed one. The store always sees and
   *                returns PLAINTEXT secrets; encryption is applied only at the
   *                disk boundary (read decrypts, write encrypts).
   */
  constructor(
    private readonly cwd?: string,
    cipher?: EncryptionCipher,
    /**
     * Override the user-scope store directory (the `~/.code-shell` layer;
     * `credentials.json` lives directly inside it). Absent → today's
     * behavior: `join(userHome(), ".code-shell")` resolved per call.
     * Injection point for identity-scoped server deployments.
     */
    private readonly userDirOverride?: string,
  ) {
    this.cipher = cipher ?? getDefaultCredentialCipher();
  }

  private pathFor(scope: CredentialScope): string | undefined {
    if (scope !== "user" && scope !== "project") {
      throw new Error(`invalid credential scope: ${String(scope)}`);
    }
    if (scope === "user") {
      return join(this.userDirOverride ?? join(userHome(), ".code-shell"), "credentials.json");
    }
    if (!this.cwd) return undefined;
    return join(this.cwd, ".code-shell", "credentials.json");
  }

  /**
   * Decrypt a stored secret to plaintext. A value this cipher can't decrypt
   * (foreign ciphertext, or legacy plaintext under an encrypting cipher that
   * rejects it) is left as-is rather than crashing the whole store — the worst
   * case is one unusable credential, not an empty list. Re-encryption happens
   * lazily on the next save() of that credential.
   */
  private decryptSecret(stored: string): string {
    try {
      if (this.cipher.canDecrypt && !this.cipher.canDecrypt(stored)) return stored;
      return this.cipher.decrypt(stored);
    } catch (err) {
      logger.warn("credentials.decrypt_fail", { error: (err as Error).message });
      return stored;
    }
  }

  private read(scope: CredentialScope): CredentialStoreFile {
    return this.readGuarded(scope).file;
  }

  /**
   * Read the store, reporting whether the on-disk state was fully understood.
   *
   * `readable: false` means "there is a file here but this build could not
   * parse it" — NOT "there are no credentials". The distinction matters because
   * mutate() commits whatever this returns: treating an unreadable file as an
   * empty list turns any later save() into a wipe of every stored credential.
   *
   * `unknown` carries entries this build's schema rejects (for example a
   * credential type added by a newer version). They are kept verbatim so a
   * round-trip through an older build preserves rather than deletes them.
   */
  private readGuarded(scope: CredentialScope): {
    file: CredentialStoreFile;
    readable: boolean;
    unknown: unknown[];
  } {
    const empty = { ...EMPTY, credentials: [] };
    const p = this.pathFor(scope);
    if (!p) return { file: empty, readable: true, unknown: [] };
    let descriptor: number | undefined;
    try {
      const parent = lstatSync(dirname(p));
      if (parent.isSymbolicLink() || !parent.isDirectory()) {
        logger.warn("credentials.invalid_parent", { path: p });
        return { file: empty, readable: false, unknown: [] };
      }
      const metadata = lstatSync(p);
      if (
        metadata.isSymbolicLink() ||
        !metadata.isFile() ||
        metadata.size > MAX_CREDENTIAL_FILE_BYTES
      ) {
        logger.warn("credentials.file_too_large", { path: p });
        return { file: empty, readable: false, unknown: [] };
      }
      descriptor = openSync(p, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const opened = fstatSync(descriptor);
      if (!opened.isFile() || opened.size > MAX_CREDENTIAL_FILE_BYTES) {
        return { file: empty, readable: false, unknown: [] };
      }
      const raw = JSON.parse(readFileSync(descriptor, "utf8")) as Partial<CredentialStoreFile>;
      const values = Array.isArray(raw.credentials)
        ? raw.credentials.slice(0, MAX_CREDENTIALS)
        : [];
      const creds: Credential[] = [];
      const unknown: unknown[] = [];
      // Decrypt secrets at the disk boundary so all callers see plaintext.
      for (const value of values) {
        const c = normalizeCredential(value, false);
        if (!c) {
          unknown.push(value);
          continue;
        }
        if (typeof c.secret === "string" && c.secret.length > 0) {
          c.secret = this.decryptSecret(c.secret);
        }
        creds.push(c);
      }
      return { file: { version: 1, credentials: creds }, readable: true, unknown };
    } catch (error) {
      // A missing file is genuinely empty; anything else (torn JSON, EACCES)
      // is unreadable and must not be committed over.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { file: empty, readable: true, unknown: [] };
      }
      logger.warn("credentials.unreadable", { path: p, error: (error as Error).message });
      return { file: empty, readable: false, unknown: [] };
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }

  private write(
    scope: CredentialScope,
    file: CredentialStoreFile,
    /** Entries this build's schema rejected; re-emitted verbatim so an older
     *  build cannot delete a newer build's credential types. */
    preserved: readonly unknown[] = [],
  ): void {
    const p = this.pathFor(scope);
    if (!p) return;
    // Encrypt secrets at the disk boundary. `file` carries plaintext secrets
    // (read() decrypted them); serialize a copy with each secret encrypted so
    // we never persist plaintext under an encrypting cipher.
    const onDisk: CredentialStoreFile = {
      version: file.version,
      credentials: [
        ...file.credentials.map((c) =>
          typeof c.secret === "string" && c.secret.length > 0
            ? { ...c, secret: this.cipher.encrypt(c.secret) }
            : c,
        ),
        ...(preserved as Credential[]),
      ],
    };
    const encoded = JSON.stringify(onDisk, null, 2);
    if (Buffer.byteLength(encoded) > MAX_CREDENTIAL_FILE_BYTES) {
      throw new Error("credential store exceeds the maximum file size");
    }
    const parentPath = dirname(p);
    mkdirSync(parentPath, { recursive: true, mode: 0o700 });
    const parent = lstatSync(parentPath);
    if (parent.isSymbolicLink() || !parent.isDirectory()) {
      throw new Error("credential store parent must be a real directory");
    }
    try {
      const target = lstatSync(p);
      if (target.isSymbolicLink() || !target.isFile()) {
        throw new Error("credential store target must be a regular file");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    writeFileAtomic(p, encoded, 0o600);
  }

  private mutate(scope: CredentialScope, change: (file: CredentialStoreFile) => boolean): void {
    const p = this.pathFor(scope);
    if (!p) return;
    const parent = dirname(p);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const parentInfo = lstatSync(parent);
    if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) {
      throw new Error("credential store parent must be a real directory");
    }
    const release = acquireFileLock(p);
    try {
      // Reload only after acquiring the cross-process lock; otherwise two app
      // instances can each write back a stale snapshot and silently lose one.
      const { file, readable, unknown } = this.readGuarded(scope);
      // Refuse to commit over state we could not parse. Writing here would
      // replace every existing credential with whatever this mutation adds.
      if (!readable) {
        throw new Error(
          "refusing to modify an unreadable credential store; " +
            "move the corrupt file aside to start a new one",
        );
      }
      if (change(file)) this.write(scope, file, unknown);
    } finally {
      release();
    }
  }

  /** Upsert by id within a scope. */
  save(scope: CredentialScope, cred: Credential): void {
    const normalized = normalizeCredential(cred, true)!;
    const safeCredential = credentialAllowsEnvExposure(normalized.type)
      ? normalized
      : { ...normalized, exposeAsEnv: undefined };
    this.mutate(scope, (file) => {
      const idx = file.credentials.findIndex((c) => c.id === safeCredential.id);
      if (idx >= 0) file.credentials[idx] = safeCredential;
      else {
        if (file.credentials.length >= MAX_CREDENTIALS) {
          throw new Error("credential store has reached its maximum entry count");
        }
        file.credentials.push(safeCredential);
      }
      return true;
    });
  }

  /**
   * 只改元数据(label / exposeAsEnv / autoUseByAI / meta),保留 secret 原样。
   * 给 UI「编辑/开关」用 —— 渲染层拿不到明文 secret,故不能走 save(会清空)。
   * id 不存在则 no-op。
   */
  patch(
    scope: CredentialScope,
    id: string,
    fields: Partial<
      Pick<Credential, "label" | "exposeAsEnv" | "autoUseByAI" | "autoInjectByAI" | "meta">
    >,
  ): void {
    if (typeof id !== "string" || !id || id.length > MAX_CREDENTIAL_ID_CHARS || id.includes("\0")) {
      throw new Error("invalid credential id");
    }
    this.mutate(scope, (file) => {
      const idx = file.credentials.findIndex((c) => c.id === id);
      if (idx < 0) return false;
      const current = file.credentials[idx];
      const updated = normalizeCredential(
        {
          ...current,
          ...fields,
          ...(credentialAllowsEnvExposure(current.type) ? {} : { exposeAsEnv: undefined }),
        },
        true,
      )!;
      file.credentials[idx] = updated;
      return true;
    });
  }

  remove(scope: CredentialScope, id: string): void {
    if (typeof id !== "string" || !id || id.length > MAX_CREDENTIAL_ID_CHARS || id.includes("\0")) {
      throw new Error("invalid credential id");
    }
    this.mutate(scope, (file) => {
      const next = file.credentials.filter((c) => c.id !== id);
      if (next.length === file.credentials.length) return false;
      file.credentials = next;
      return true;
    });
  }

  /**
   * List credentials visible to an engine of the given settings scope.
   *   - "full" (default): merge user(~/.code-shell) then project, project wins —
   *     the host-application behavior.
   *   - "project": ONLY the project store. A project/isolated-scope engine
   *     (e.g. SDK-embedded) must never surface the host user's credentials —
   *     same host-isolation contract as {@link envExposures} and top-level env.
   */
  list(scope: "full" | "project" = "full"): Credential[] {
    const byId = new Map<string, Credential>();
    if (scope === "full") {
      for (const c of this.read("user").credentials) byId.set(c.id, c);
    }
    for (const c of this.read("project").credentials) byId.set(c.id, c); // project wins
    return [...byId.values()];
  }

  resolve(id: string, scope: "full" | "project" = "full"): Credential | undefined {
    return this.list(scope).find((c) => c.id === id);
  }

  /**
   * Credentials flagged "expose as env var" → a `{ ENV_NAME: secret }` map for
   * layering into the shell env (Engine.readShellEnv). This is the missing
   * consumer of `Credential.exposeAsEnv` — the UI/store recorded the flag but
   * nothing injected the secret, so `$FIGMA_TOKEN` was always empty.
   *
   * `scope` mirrors the engine's settings scope to keep the host-isolation
   * contract identical to top-level `env`:
   *   - "full": merge user(~/.code-shell) then project (project wins), matching
   *     `list()` precedence.
   *   - "project": ONLY the project store — a project-scoped engine must never
   *     surface the host user's credentials (SDK-embedding safety).
   * Only credentials with BOTH a non-empty exposeAsEnv and a non-empty secret
   * contribute; a later layer (project) overrides an earlier env name.
   */
  envExposures(scope: "full" | "project"): Record<string, string> {
    const out: Record<string, string> = {};
    const layers: Credential[][] =
      scope === "project"
        ? [this.read("project").credentials]
        : [this.read("user").credentials, this.read("project").credentials];
    for (const layer of layers) {
      for (const c of layer) {
        if (!credentialAllowsEnvExposure(c.type)) continue;
        const name = c.exposeAsEnv?.trim();
        if (name && typeof c.secret === "string" && c.secret.length > 0) {
          out[name] = c.secret;
        }
      }
    }
    return out;
  }

  listMasked(scope: "full" | "project" = "full"): MaskedCredential[] {
    return this.list(scope).map((c) => {
      const { secret, ...rest } = c;
      return {
        ...rest,
        ...(credentialAllowsEnvExposure(c.type) ? {} : { exposeAsEnv: undefined }),
        hasSecret: typeof secret === "string" && secret.length > 0,
        secretHint: credentialSecretHint(c.type, secret),
        ...(c.type === "oauth" || isBrowserOAuthLinkCredential(c)
          ? { oauthStatus: summarizeOAuthCredentialSecret(secret) }
          : {}),
      };
    });
  }
}
