import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type { Credential, CredentialStoreFile } from "./types.js";

/** 测试可经 process.env.HOME 覆盖(镜像 settings/manager.ts userHome)。 */
function userHome(): string {
  return process.env.HOME ?? homedir();
}

export type CredentialScope = "user" | "project";

export interface MaskedCredential extends Omit<Credential, "secret"> {
  hasSecret: boolean;
  /** 形如 `****abcd`,绝不含完整明文。 */
  secretHint?: string;
}

const EMPTY: CredentialStoreFile = { version: 1, credentials: [] };

/**
 * 两层凭证库,镜像 SettingsManager 的 user(~/.code-shell)/ project(<cwd>/.code-shell)
 * 双层模型。只存 token / link;cookie 不进库(见 credentials-module 设计稿)。
 */
export class CredentialStore {
  constructor(private readonly cwd?: string) {}

  private pathFor(scope: CredentialScope): string | undefined {
    if (scope === "user") return join(userHome(), ".code-shell", "credentials.json");
    if (!this.cwd) return undefined;
    return join(this.cwd, ".code-shell", "credentials.json");
  }

  private read(scope: CredentialScope): CredentialStoreFile {
    const p = this.pathFor(scope);
    if (!p || !existsSync(p)) return { ...EMPTY, credentials: [] };
    try {
      const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<CredentialStoreFile>;
      return { version: 1, credentials: Array.isArray(raw.credentials) ? raw.credentials : [] };
    } catch {
      return { ...EMPTY, credentials: [] };
    }
  }

  private write(scope: CredentialScope, file: CredentialStoreFile): void {
    const p = this.pathFor(scope);
    if (!p) return;
    mkdirSync(dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.${String(performance.now()).replace(".", "")}.tmp`;
    writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
    renameSync(tmp, p);
  }

  /** Upsert by id within a scope. */
  save(scope: CredentialScope, cred: Credential): void {
    const file = this.read(scope);
    const idx = file.credentials.findIndex((c) => c.id === cred.id);
    if (idx >= 0) file.credentials[idx] = cred;
    else file.credentials.push(cred);
    this.write(scope, file);
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
    const file = this.read(scope);
    const idx = file.credentials.findIndex((c) => c.id === id);
    if (idx < 0) return;
    file.credentials[idx] = { ...file.credentials[idx], ...fields };
    this.write(scope, file);
  }

  remove(scope: CredentialScope, id: string): void {
    const file = this.read(scope);
    file.credentials = file.credentials.filter((c) => c.id !== id);
    this.write(scope, file);
  }

  /** Merged list: project overrides user on same id. */
  list(): Credential[] {
    const byId = new Map<string, Credential>();
    for (const c of this.read("user").credentials) byId.set(c.id, c);
    for (const c of this.read("project").credentials) byId.set(c.id, c); // project wins
    return [...byId.values()];
  }

  resolve(id: string): Credential | undefined {
    return this.list().find((c) => c.id === id);
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
        const name = c.exposeAsEnv?.trim();
        if (name && typeof c.secret === "string" && c.secret.length > 0) {
          out[name] = c.secret;
        }
      }
    }
    return out;
  }

  listMasked(): MaskedCredential[] {
    return this.list().map((c) => {
      const { secret, ...rest } = c;
      return {
        ...rest,
        hasSecret: typeof secret === "string" && secret.length > 0,
        // Reveal at most the last 4 chars — and ONLY when the secret is longer
        // than 4, so those chars aren't the whole secret. `"ab".slice(-4)` is
        // "ab", so a short secret would otherwise leak in full through the hint.
        secretHint: secret ? (secret.length > 4 ? `****${secret.slice(-4)}` : "****") : undefined,
      };
    });
  }
}
