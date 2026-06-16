# 凭证模块 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 主页面左侧新增「凭证」顶层页,分 Cookie / Permission Token / Link 三 tab;Token/Link 常驻在 core 的两层 CredentialStore,Cookie 复用浏览器 persist 分区现抓;MCP 可绑定凭证;三类被工具使用时共用同一审批/记忆门。

**Architecture:** core 新增 `CredentialStore`(镜像 SettingsManager 的两层 + userHome + 原子写),只存 token/link。desktop main 经 IPC 暴露 CRUD,并经 Electron `session.fromPartition("persist:browser").cookies` 现抓 cookie 生成临时 cookies.txt(Cookie Lease 雏形)。renderer 新增 `credentials` view + 3-tab 页(镜像 ManagePage 结构)。MCP 编辑器加「使用凭证」绑定 → core 连接时解析成 bearerToken。

**Tech Stack:** TypeScript, bun:test (core), Electron IPC, React 19 + shadcn/ui + Tailwind v4 (renderer).

**测试运行:** core 用 `cd packages/core && bun test src/credentials/` (带 src/ 避 dist 旧测试)。desktop 用 `cd packages/desktop && bunx tsc --noEmit` + `bun test`。

---

## File Structure

**core (新建 `packages/core/src/credentials/`):**
- `types.ts` — `Credential`, `CredentialType`, `CredentialStoreFile` 类型。
- `store.ts` — `CredentialStore` 类:两层读写、合并、原子写、resolve。
- `store.test.ts` — 单测。
- `index.ts` — re-export。
- Modify `packages/core/src/index.ts` — 导出。
- Modify `packages/core/src/types.ts` — `MCPServerConfig` 加 `credentialRef?`;`ApprovalRequest` 加可选 `credential` 元信息(非破坏)。
- Modify `packages/core/src/tool-system/mcp-manager.ts` — `buildHttpHeaders` 接受可选凭证解析回调。

**desktop main:**
- Create `packages/desktop/src/main/credentials-service.ts` — 包装 CredentialStore + cookie 抓取 + cookies.txt 物化。
- Create `packages/desktop/src/main/credentials-service.test.ts` — cookies.txt 格式单测。
- Modify `packages/desktop/src/main/index.ts` — 注册 `credentials:*` IPC handlers。

**desktop preload:**
- Modify `packages/desktop/src/preload/index.ts` — 暴露 `credentials.*`。
- Modify `packages/desktop/src/preload/types.d.ts` — 类型。

**desktop renderer (新建 `packages/desktop/src/renderer/credentials/`):**
- `types.ts` — renderer 侧 Credential 视图类型(镜像 core)。
- `CredentialsPage.tsx` — 3-tab 容器。
- `TokenTab.tsx` — token CRUD。
- `LinkTab.tsx` — link CRUD。
- `CookieTab.tsx` — 已登陆域名列表 + 在浏览器打开 + 抓取预览。
- `CredentialsPage.test.tsx` — 渲染锁定测试。
- Modify `packages/desktop/src/renderer/view.ts` — `credentials` view。
- Modify `packages/desktop/src/renderer/SidebarNav.tsx` — 导航项。
- Modify `packages/desktop/src/renderer/ui/icons.tsx` — Key 图标。
- Modify `packages/desktop/src/renderer/App.tsx` — render switch。
- Modify `packages/desktop/src/renderer/settings/McpSection.tsx` — 「使用凭证」下拉。

---

## Task 1: core Credential types

**Files:**
- Create: `packages/core/src/credentials/types.ts`

- [ ] **Step 1: Write the types**

```typescript
// packages/core/src/credentials/types.ts
/** 常驻凭证:仅 token / link。Cookie 不进库(源常驻 persist:browser 分区,用时现抓)。 */
export type CredentialType = "token" | "link";

export interface Credential {
  /** 引用键,kebab-case,如 "my-figma-token"。全局/项目两层内唯一。 */
  id: string;
  type: CredentialType;
  /** 展示名。 */
  label: string;
  /** 密文:token 值;link 为 client id/secret 等的 JSON 字符串。UI 只显示掩码。 */
  secret?: string;
  /** 可选:静态暴露为该 shell env 变量名(进 readShellEnv)。 */
  exposeAsEnv?: string;
  /** link: 业务方 app 注册地址。 */
  meta?: { appUrl?: string };
}

export interface CredentialStoreFile {
  version: 1;
  credentials: Credential[];
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/core/src/credentials/types.ts
git commit -m "feat(core): 凭证模块数据类型(token/link)"
```

---

## Task 2: core CredentialStore (two-layer, atomic, masked)

**Files:**
- Create: `packages/core/src/credentials/store.ts`
- Test: `packages/core/src/credentials/store.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/core/src/credentials/store.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CredentialStore } from "./store.js";

describe("CredentialStore", () => {
  let home: string;
  let cwd: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    prevHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "cs-cred-home-"));
    cwd = mkdtempSync(join(tmpdir(), "cs-cred-cwd-"));
    process.env.HOME = home;
  });
  afterEach(() => {
    process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  test("save+list round-trips at user scope", () => {
    const store = new CredentialStore(cwd);
    store.save("user", { id: "tok-a", type: "token", label: "A", secret: "s1" });
    expect(store.list().map((c) => c.id)).toContain("tok-a");
  });

  test("writes to ~/.code-shell/credentials.json for user scope", () => {
    const store = new CredentialStore(cwd);
    store.save("user", { id: "tok-a", type: "token", label: "A", secret: "s1" });
    const p = join(home, ".code-shell", "credentials.json");
    expect(existsSync(p)).toBe(true);
    expect(JSON.parse(readFileSync(p, "utf8")).credentials[0].id).toBe("tok-a");
  });

  test("project scope overrides user scope on same id", () => {
    const store = new CredentialStore(cwd);
    store.save("user", { id: "dup", type: "token", label: "global", secret: "g" });
    store.save("project", { id: "dup", type: "token", label: "local", secret: "l" });
    const merged = store.list();
    const dup = merged.filter((c) => c.id === "dup");
    expect(dup).toHaveLength(1);
    expect(dup[0].label).toBe("local");
  });

  test("resolve returns the merged credential by id", () => {
    const store = new CredentialStore(cwd);
    store.save("user", { id: "tok-a", type: "token", label: "A", secret: "s1" });
    expect(store.resolve("tok-a")?.secret).toBe("s1");
    expect(store.resolve("missing")).toBeUndefined();
  });

  test("remove deletes from the given scope", () => {
    const store = new CredentialStore(cwd);
    store.save("user", { id: "tok-a", type: "token", label: "A", secret: "s1" });
    store.remove("user", "tok-a");
    expect(store.resolve("tok-a")).toBeUndefined();
  });

  test("mask hides secret value", () => {
    const store = new CredentialStore(cwd);
    store.save("user", { id: "tok-a", type: "token", label: "A", secret: "supersecretvalue" });
    const masked = store.listMasked();
    const m = masked.find((c) => c.id === "tok-a")!;
    expect(m.secret).toBeUndefined();
    expect(m.hasSecret).toBe(true);
    expect(m.secretHint).toMatch(/\*\*\*\*/);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `cd packages/core && bun test src/credentials/store.test.ts`
Expected: FAIL — cannot find `./store.js`.

- [ ] **Step 3: Implement CredentialStore**

```typescript
// packages/core/src/credentials/store.ts
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  rmSync,
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

  listMasked(): MaskedCredential[] {
    return this.list().map((c) => {
      const { secret, ...rest } = c;
      return {
        ...rest,
        hasSecret: typeof secret === "string" && secret.length > 0,
        secretHint: secret ? `****${secret.slice(-4)}` : undefined,
      };
    });
  }
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `cd packages/core && bun test src/credentials/store.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/credentials/store.ts packages/core/src/credentials/store.test.ts
git commit -m "feat(core): CredentialStore 两层读写/合并/掩码(TDD)"
```

---

## Task 3: core index export

**Files:**
- Create: `packages/core/src/credentials/index.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Write barrel**

```typescript
// packages/core/src/credentials/index.ts
export { CredentialStore } from "./store.js";
export type { CredentialScope, MaskedCredential } from "./store.js";
export type { Credential, CredentialType, CredentialStoreFile } from "./types.js";
```

- [ ] **Step 2: Add to core index.ts** (near the settings exports, ~line 425)

```typescript
export {
  CredentialStore,
  type CredentialScope,
  type MaskedCredential,
  type Credential,
  type CredentialType,
  type CredentialStoreFile,
} from "./credentials/index.js";
```

- [ ] **Step 3: Verify typecheck**

Run: `cd packages/core && bunx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/credentials/index.ts packages/core/src/index.ts
git commit -m "feat(core): 导出 CredentialStore"
```

---

## Task 4: MCPServerConfig.credentialRef + buildHttpHeaders resolve hook

**Files:**
- Modify: `packages/core/src/types.ts` (MCPServerConfig)
- Modify: `packages/core/src/tool-system/mcp-manager.ts` (buildHttpHeaders)
- Test: `packages/core/src/tool-system/mcp-manager.test.ts` (append)

- [ ] **Step 1: Write failing test** (append to existing describe in mcp-manager.test.ts)

```typescript
describe("buildHttpHeaders credentialRef", () => {
  test("resolves credentialRef to a Bearer token via the resolver", () => {
    const headers = buildHttpHeaders(
      "figma",
      { name: "figma", transport: "streamable-http", credentialRef: "my-figma-token" },
      (id) => (id === "my-figma-token" ? "figd_secret" : undefined),
    );
    expect(headers["Authorization"]).toBe("Bearer figd_secret");
  });

  test("missing credential throws a friendly error", () => {
    expect(() =>
      buildHttpHeaders(
        "figma",
        { name: "figma", transport: "streamable-http", credentialRef: "nope" },
        () => undefined,
      ),
    ).toThrow(/credential "nope"/);
  });

  test("no credentialRef behaves as before", () => {
    process.env.MCP_TOKEN = "t";
    const headers = buildHttpHeaders("s", {
      name: "s",
      transport: "streamable-http",
      bearerTokenEnvVar: "MCP_TOKEN",
    });
    expect(headers["Authorization"]).toBe("Bearer t");
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `cd packages/core && bun test src/tool-system/mcp-manager.test.ts`
Expected: FAIL — `credentialRef` not on type / resolver arg unused.

- [ ] **Step 3: Add `credentialRef` to MCPServerConfig** in `packages/core/src/types.ts` (in the interface, after `envHeaders`)

```typescript
  /**
   * (HTTP) id of a stored credential (CredentialStore) to use as the Bearer
   * token. Resolved at connect time via a resolver passed to buildHttpHeaders;
   * the secret is never stored in the MCP config. Wins over bearerTokenEnvVar.
   */
  credentialRef?: string;
```

- [ ] **Step 4: Extend buildHttpHeaders** in `packages/core/src/tool-system/mcp-manager.ts`

```typescript
export function buildHttpHeaders(
  serverName: string,
  config: MCPServerConfig,
  resolveCredential?: (id: string) => string | undefined,
): Record<string, string> {
  const headers: Record<string, string> = { ...(config.headers ?? {}) };
  if (config.credentialRef) {
    const secret = resolveCredential?.(config.credentialRef);
    if (secret === undefined || secret === "") {
      throw new Error(
        `MCP server "${serverName}": credential "${config.credentialRef}" not found or empty`,
      );
    }
    headers["Authorization"] = `Bearer ${secret}`;
  } else if (config.bearerTokenEnvVar) {
    headers["Authorization"] = `Bearer ${readRequiredEnv(
      serverName,
      "bearerTokenEnvVar",
      config.bearerTokenEnvVar,
    )}`;
  }
  for (const [hName, envName] of Object.entries(config.envHeaders ?? {})) {
    headers[hName] = readRequiredEnv(serverName, "envHeaders", envName);
  }
  return headers;
}
```

- [ ] **Step 5: Run test, verify it passes**

Run: `cd packages/core && bun test src/tool-system/mcp-manager.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/tool-system/mcp-manager.ts packages/core/src/tool-system/mcp-manager.test.ts
git commit -m "feat(core): MCP credentialRef→Bearer 解析(TDD)"
```

---

## Task 5: desktop main credentials-service — cookies.txt formatting

**Files:**
- Create: `packages/desktop/src/main/credentials-service.ts`
- Test: `packages/desktop/src/main/credentials-service.test.ts`

- [ ] **Step 1: Write failing test** (Netscape format — pure function, no Electron)

```typescript
// packages/desktop/src/main/credentials-service.test.ts
import { describe, test, expect } from "bun:test";
import { formatNetscapeCookies, type ElectronCookieLike } from "./credentials-service.js";

describe("formatNetscapeCookies", () => {
  test("emits the Netscape header line", () => {
    const out = formatNetscapeCookies([]);
    expect(out.split("\n")[0]).toBe("# Netscape HTTP Cookie File");
  });

  test("maps one cookie to 7 tab-separated fields", () => {
    const c: ElectronCookieLike = {
      domain: ".example.com",
      hostOnly: false,
      path: "/",
      secure: true,
      expirationDate: 1893456000,
      name: "sid",
      value: "abc",
    };
    const lines = formatNetscapeCookies([c]).trim().split("\n");
    const fields = lines[lines.length - 1].split("\t");
    expect(fields).toEqual([".example.com", "TRUE", "/", "TRUE", "1893456000", "sid", "abc"]);
  });

  test("hostOnly cookie → include-subdomains FALSE", () => {
    const c: ElectronCookieLike = { domain: "x.com", hostOnly: true, path: "/", secure: false, name: "a", value: "1" };
    const fields = formatNetscapeCookies([c]).trim().split("\n").pop()!.split("\t");
    expect(fields[1]).toBe("FALSE");
    expect(fields[3]).toBe("FALSE");
  });

  test("session cookie (no expirationDate) → 0", () => {
    const c: ElectronCookieLike = { domain: "x.com", path: "/", secure: false, name: "a", value: "1" };
    const fields = formatNetscapeCookies([c]).trim().split("\n").pop()!.split("\t");
    expect(fields[4]).toBe("0");
  });

  test("skips cookies whose name/value contain tab or newline", () => {
    const bad: ElectronCookieLike = { domain: "x.com", path: "/", secure: false, name: "a\tb", value: "v" };
    const good: ElectronCookieLike = { domain: "x.com", path: "/", secure: false, name: "ok", value: "v" };
    const lines = formatNetscapeCookies([bad, good]).trim().split("\n");
    // header + 1 good cookie only
    expect(lines).toHaveLength(2);
    expect(lines[1].split("\t")[5]).toBe("ok");
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `cd packages/desktop && bun test src/main/credentials-service.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement credentials-service.ts**

```typescript
// packages/desktop/src/main/credentials-service.ts
import { session } from "electron";
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** Subset of Electron's Cookie we rely on (keeps the formatter unit-testable). */
export interface ElectronCookieLike {
  domain?: string;
  hostOnly?: boolean;
  path?: string;
  secure?: boolean;
  expirationDate?: number;
  name: string;
  value: string;
}

const BROWSER_PARTITION = "persist:browser";
const LEASE_DIR = join(tmpdir(), "codeshell-cookie-leases");
const LEASE_MAX_AGE_MS = 5 * 60 * 1000;

function bad(s: string): boolean {
  return s.includes("\t") || s.includes("\n") || s.includes("\r");
}

/** Electron Cookie[] → Netscape cookies.txt string. */
export function formatNetscapeCookies(cookies: ElectronCookieLike[]): string {
  const lines = ["# Netscape HTTP Cookie File"];
  for (const c of cookies) {
    if (bad(c.name) || bad(c.value) || (c.domain && bad(c.domain))) continue;
    const domain = c.domain ?? "";
    const includeSub = c.hostOnly === true ? "FALSE" : "TRUE";
    const path = c.path ?? "/";
    const secure = c.secure ? "TRUE" : "FALSE";
    const expiry = typeof c.expirationDate === "number" ? String(Math.floor(c.expirationDate)) : "0";
    lines.push([domain, includeSub, path, secure, expiry, c.name, c.value].join("\t"));
  }
  return lines.join("\n") + "\n";
}

/** List distinct registrable-ish domains that have cookies in the browser partition. */
export async function listCookieDomains(): Promise<string[]> {
  const all = await session.fromPartition(BROWSER_PARTITION).cookies.get({});
  const set = new Set<string>();
  for (const c of all) if (c.domain) set.add(c.domain.replace(/^\./, ""));
  return [...set].sort();
}

/** Read cookies for a domain (matches sub-domains via Electron's domain filter). */
export async function getCookiesForDomain(domain: string): Promise<ElectronCookieLike[]> {
  const sess = session.fromPartition(BROWSER_PARTITION);
  // Electron's `domain` filter does suffix matching; pass the bare host.
  return (await sess.cookies.get({ domain })) as ElectronCookieLike[];
}

/** Materialize a temporary cookies.txt for `domain`; returns its path. Caller cleans up. */
export async function createCookieLease(domain: string): Promise<{ filePath: string; count: number }> {
  const cookies = await getCookiesForDomain(domain);
  mkdirSync(LEASE_DIR, { recursive: true });
  const filePath = join(LEASE_DIR, `lease-${Date.now()}-${process.pid}.txt`);
  writeFileSync(filePath, formatNetscapeCookies(cookies), { mode: 0o600 });
  return { filePath, count: cookies.length };
}

export function cleanupLease(filePath: string): void {
  try {
    if (existsSync(filePath)) rmSync(filePath, { force: true });
  } catch {
    /* best-effort */
  }
}

/** Startup sweep: remove stale lease files older than LEASE_MAX_AGE_MS. */
export function sweepStaleLeases(now = Date.now()): void {
  try {
    if (!existsSync(LEASE_DIR)) return;
    for (const f of readdirSync(LEASE_DIR)) {
      const p = join(LEASE_DIR, f);
      try {
        if (now - statSync(p).mtimeMs > LEASE_MAX_AGE_MS) rmSync(p, { force: true });
      } catch {
        /* skip */
      }
    }
  } catch {
    /* best-effort */
  }
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `cd packages/desktop && bun test src/main/credentials-service.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/main/credentials-service.ts packages/desktop/src/main/credentials-service.test.ts
git commit -m "feat(desktop): cookie 现抓→Netscape cookies.txt 物化+lease 清理(TDD)"
```

---

## Task 6: desktop main IPC handlers

**Files:**
- Modify: `packages/desktop/src/main/index.ts`

- [ ] **Step 1: Add imports** near other core imports

```typescript
import { CredentialStore, type Credential, type CredentialScope } from "@cjhyy/code-shell-core";
import {
  listCookieDomains,
  createCookieLease,
  cleanupLease,
  sweepStaleLeases,
} from "./credentials-service.js";
```

- [ ] **Step 2: Register handlers** near the other `ipcMain.handle("plugins:list", ...)` block (~line 1018). `cwd` may be empty string for no-repo (then project scope no-ops on its own).

```typescript
ipcMain.handle("credentials:list", async (_e, cwd: string) => {
  return new CredentialStore(cwd || undefined).listMasked();
});
ipcMain.handle("credentials:save", async (_e, cwd: string, scope: CredentialScope, cred: Credential) => {
  new CredentialStore(cwd || undefined).save(scope, cred);
});
ipcMain.handle("credentials:remove", async (_e, cwd: string, scope: CredentialScope, id: string) => {
  new CredentialStore(cwd || undefined).remove(scope, id);
});
ipcMain.handle("credentials:cookieDomains", async () => listCookieDomains());
ipcMain.handle("credentials:cookiePreview", async (_e, domain: string) => {
  const { filePath, count } = await createCookieLease(domain);
  // Preview only — return count + path, then immediately clean the lease.
  cleanupLease(filePath);
  return { count };
});
```

- [ ] **Step 3: Call sweepStaleLeases on app ready** — find the app startup (grep `app.whenReady` or `app.on("ready"`) and add `sweepStaleLeases();` inside.

- [ ] **Step 4: Verify typecheck**

Run: `cd packages/desktop && bunx tsc --noEmit`
Expected: no new errors (renderer build separate; main is covered by desktop tsconfig).

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/main/index.ts
git commit -m "feat(desktop): credentials:* IPC handlers + 启动清理残留 lease"
```

---

## Task 7: preload bridge

**Files:**
- Modify: `packages/desktop/src/preload/index.ts`
- Modify: `packages/desktop/src/preload/types.d.ts`

- [ ] **Step 1: Add to the exposeInMainWorld object** (near other invoke methods)

```typescript
  credentials: {
    list: (cwd: string) => ipcRenderer.invoke("credentials:list", cwd),
    save: (cwd: string, scope: "user" | "project", cred: unknown) =>
      ipcRenderer.invoke("credentials:save", cwd, scope, cred),
    remove: (cwd: string, scope: "user" | "project", id: string) =>
      ipcRenderer.invoke("credentials:remove", cwd, scope, id),
    cookieDomains: (): Promise<string[]> => ipcRenderer.invoke("credentials:cookieDomains"),
    cookiePreview: (domain: string): Promise<{ count: number }> =>
      ipcRenderer.invoke("credentials:cookiePreview", domain),
  },
```

- [ ] **Step 2: Add types to types.d.ts** in the `codeshell` interface

```typescript
    credentials: {
      list: (cwd: string) => Promise<MaskedCredentialView[]>;
      save: (cwd: string, scope: "user" | "project", cred: CredentialView) => Promise<void>;
      remove: (cwd: string, scope: "user" | "project", id: string) => Promise<void>;
      cookieDomains: () => Promise<string[]>;
      cookiePreview: (domain: string) => Promise<{ count: number }>;
    };
```

And add the view types (top of types.d.ts):

```typescript
export interface CredentialView {
  id: string;
  type: "token" | "link";
  label: string;
  secret?: string;
  exposeAsEnv?: string;
  meta?: { appUrl?: string };
}
export interface MaskedCredentialView extends Omit<CredentialView, "secret"> {
  hasSecret: boolean;
  secretHint?: string;
}
```

- [ ] **Step 3: Verify typecheck**

Run: `cd packages/desktop && bunx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add packages/desktop/src/preload/index.ts packages/desktop/src/preload/types.d.ts
git commit -m "feat(desktop): preload 暴露 credentials.* 桥"
```

---

## Task 8: renderer view + nav + icon wiring

**Files:**
- Modify: `packages/desktop/src/renderer/view.ts`
- Modify: `packages/desktop/src/renderer/SidebarNav.tsx`
- Modify: `packages/desktop/src/renderer/ui/icons.tsx`

- [ ] **Step 1: view.ts** — add `| "credentials"` to ViewMode union AND `"credentials"` to VALID_MODES set.

- [ ] **Step 2: icons.tsx** — ensure `KeyRound` (or `Key`) is exported from lucide-react (add to the import/export list).

- [ ] **Step 3: SidebarNav.tsx** — import the icon and add to ITEMS (after `automation`, before `logs`):

```typescript
  { id: "credentials", label: "凭证", Icon: KeyRound },
```

(add `KeyRound` to the icons import at top.)

- [ ] **Step 4: Verify typecheck**

Run: `cd packages/desktop && bunx tsc --noEmit`
Expected: no new errors (App.tsx switch added next task; an unhandled view falls through to chat which is fine temporarily).

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/renderer/view.ts packages/desktop/src/renderer/SidebarNav.tsx packages/desktop/src/renderer/ui/icons.tsx
git commit -m "feat(desktop): 凭证 view 类型 + 侧边导航项"
```

---

## Task 9: renderer credentials types + page shell + tabs

**Files:**
- Create: `packages/desktop/src/renderer/credentials/types.ts`
- Create: `packages/desktop/src/renderer/credentials/CredentialsPage.tsx`
- Create: `packages/desktop/src/renderer/credentials/TokenTab.tsx`
- Create: `packages/desktop/src/renderer/credentials/LinkTab.tsx`
- Create: `packages/desktop/src/renderer/credentials/CookieTab.tsx`

- [ ] **Step 1: types.ts**

```typescript
// packages/desktop/src/renderer/credentials/types.ts
export interface CredentialView {
  id: string;
  type: "token" | "link";
  label: string;
  secret?: string;
  exposeAsEnv?: string;
  meta?: { appUrl?: string };
}
export interface MaskedCredentialView extends Omit<CredentialView, "secret"> {
  hasSecret: boolean;
  secretHint?: string;
}
```

- [ ] **Step 2: TokenTab.tsx** (full CRUD; shadcn Input/Button/Card; useToast)

```tsx
// packages/desktop/src/renderer/credentials/TokenTab.tsx
import React, { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { useToast } from "../ui/ToastProvider";
import { useConfirm } from "../ui/DialogProvider";
import type { MaskedCredentialView } from "./types";

export function TokenTab({ cwd, kind }: { cwd: string; kind: "token" | "link" }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [items, setItems] = useState<MaskedCredentialView[]>([]);
  const [id, setId] = useState("");
  const [label, setLabel] = useState("");
  const [secret, setSecret] = useState("");
  const [exposeAsEnv, setExposeAsEnv] = useState("");
  const [appUrl, setAppUrl] = useState("");

  const load = React.useCallback(() => {
    void window.codeshell.credentials.list(cwd).then((all) =>
      setItems(all.filter((c) => c.type === kind)),
    );
  }, [cwd, kind]);
  useEffect(load, [load]);

  const save = async () => {
    if (!id.trim() || !label.trim()) {
      toast({ message: "id 和名称必填", variant: "error" });
      return;
    }
    await window.codeshell.credentials.save(cwd, "user", {
      id: id.trim(),
      type: kind,
      label: label.trim(),
      secret: secret || undefined,
      exposeAsEnv: exposeAsEnv.trim() || undefined,
      meta: kind === "link" && appUrl.trim() ? { appUrl: appUrl.trim() } : undefined,
    });
    toast({ message: "已保存" });
    setId(""); setLabel(""); setSecret(""); setExposeAsEnv(""); setAppUrl("");
    load();
  };

  const del = async (cid: string) => {
    if (!(await confirm({ message: `删除凭证 ${cid}?`, destructive: true }))) return;
    await window.codeshell.credentials.remove(cwd, "user", cid);
    load();
  };

  return (
    <div className="space-y-4">
      <Card className="space-y-3 p-4">
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label>id(引用键)</Label>
            <Input value={id} onChange={(e) => setId(e.target.value)} placeholder="my-figma-token" />
          </div>
          <div className="space-y-1">
            <Label>名称</Label>
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Figma 个人 token" />
          </div>
        </div>
        <div className="space-y-1">
          <Label>{kind === "token" ? "Token 值" : "凭证(client id/secret 等)"}</Label>
          <Input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} />
        </div>
        {kind === "link" && (
          <div className="space-y-1">
            <Label>注册地址(可选)</Label>
            <Input value={appUrl} onChange={(e) => setAppUrl(e.target.value)} placeholder="https://..." />
          </div>
        )}
        <div className="space-y-1">
          <Label>暴露为 env 变量名(可选)</Label>
          <Input value={exposeAsEnv} onChange={(e) => setExposeAsEnv(e.target.value)} placeholder="FIGMA_TOKEN" />
        </div>
        <Button onClick={() => void save()}>保存</Button>
      </Card>

      <div className="space-y-2">
        {items.length === 0 && <p className="text-sm text-muted-foreground">暂无{kind === "token" ? "凭证" : " Link"}。</p>}
        {items.map((c) => (
          <Card key={c.id} className="flex items-center justify-between p-3">
            <div className="min-w-0">
              <div className="truncate font-medium">{c.label} <span className="text-xs text-muted-foreground">({c.id})</span></div>
              <div className="text-xs text-muted-foreground">
                {c.hasSecret ? c.secretHint : "(无密文)"}
                {c.exposeAsEnv ? ` · env: ${c.exposeAsEnv}` : ""}
                {c.meta?.appUrl ? ` · ${c.meta.appUrl}` : ""}
              </div>
            </div>
            <Button variant="ghost" size="sm" onClick={() => void del(c.id)}>删除</Button>
          </Card>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: LinkTab.tsx** — thin wrapper reusing TokenTab with kind="link"

```tsx
// packages/desktop/src/renderer/credentials/LinkTab.tsx
import React from "react";
import { TokenTab } from "./TokenTab";
export function LinkTab({ cwd }: { cwd: string }) {
  return <TokenTab cwd={cwd} kind="link" />;
}
```

- [ ] **Step 4: CookieTab.tsx** — list logged-in domains + open in browser + preview count

```tsx
// packages/desktop/src/renderer/credentials/CookieTab.tsx
import React, { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { useToast } from "../ui/ToastProvider";

export function CookieTab() {
  const toast = useToast();
  const [domains, setDomains] = useState<string[]>([]);
  const [url, setUrl] = useState("");

  const load = () => void window.codeshell.credentials.cookieDomains().then(setDomains);
  useEffect(load, []);

  const preview = async (domain: string) => {
    const { count } = await window.codeshell.credentials.cookiePreview(domain);
    toast({ message: `${domain}: ${count} 个 cookie 可桥接` });
  };

  return (
    <div className="space-y-4">
      <Card className="space-y-3 p-4">
        <p className="text-sm text-muted-foreground">
          在内置浏览器登陆目标站点,登录态会留在浏览器分区。AI 用 yt-dlp / curl 等需要 cookie 时会弹审批,
          经允许后临时桥接,不长期存储 cookie。
        </p>
        <div className="flex gap-2">
          <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://www.xiaohongshu.com" />
          <Button
            onClick={() => {
              if (!url.trim()) return;
              void window.codeshell.openBrowserPopout(url.trim());
            }}
          >
            在浏览器打开登陆
          </Button>
        </div>
      </Card>

      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">已有登录态的域名</h3>
        <Button variant="ghost" size="sm" onClick={load}>刷新</Button>
      </div>
      <div className="space-y-2">
        {domains.length === 0 && <p className="text-sm text-muted-foreground">浏览器分区暂无 cookie。先登陆一个站点。</p>}
        {domains.map((d) => (
          <Card key={d} className="flex items-center justify-between p-3">
            <span className="truncate font-mono text-sm">{d}</span>
            <Button variant="ghost" size="sm" onClick={() => void preview(d)}>预览数量</Button>
          </Card>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: CredentialsPage.tsx** — 3-tab container (mirror ManagePage custom-button tabs)

```tsx
// packages/desktop/src/renderer/credentials/CredentialsPage.tsx
import React, { useState } from "react";
import { TokenTab } from "./TokenTab";
import { LinkTab } from "./LinkTab";
import { CookieTab } from "./CookieTab";

type TabKey = "cookie" | "token" | "link";

export function CredentialsPage({ activeRepoPath }: { activeRepoPath: string | null }) {
  const [tab, setTab] = useState<TabKey>("cookie");
  const cwd = activeRepoPath ?? "";

  const tabBtn = (key: TabKey, label: string) => (
    <button
      key={key}
      className={
        "rounded-md px-3 py-1.5 text-sm font-medium transition-colors " +
        (tab === key ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60")
      }
      onClick={() => setTab(key)}
    >
      {label}
    </button>
  );

  return (
    <div className="h-full overflow-y-auto p-6">
      <h2 className="mb-1 text-lg font-semibold">凭证</h2>
      <p className="mb-4 text-sm text-muted-foreground">Cookie 登录态桥接、Permission Token、业务方 Link 凭证。</p>
      <div className="mb-4 flex items-center gap-1">
        {tabBtn("cookie", "Cookie")}
        {tabBtn("token", "Permission Token")}
        {tabBtn("link", "Link")}
      </div>
      {tab === "cookie" && <CookieTab />}
      {tab === "token" && <TokenTab cwd={cwd} kind="token" />}
      {tab === "link" && <LinkTab cwd={cwd} />}
    </div>
  );
}
```

- [ ] **Step 6: Verify typecheck**

Run: `cd packages/desktop && bunx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 7: Commit**

```bash
git add packages/desktop/src/renderer/credentials/
git commit -m "feat(desktop): 凭证页 3 tab(Cookie/Token/Link)UI"
```

---

## Task 10: wire CredentialsPage into App.tsx render switch

**Files:**
- Modify: `packages/desktop/src/renderer/App.tsx`

- [ ] **Step 1: Import** at top

```typescript
import { CredentialsPage } from "./credentials/CredentialsPage";
```

- [ ] **Step 2: Add to the viewMode conditional chain** (the `else if (view.viewMode === "customize" ? ... )` ternary chain around line 2507). Add a branch:

```tsx
              ) : view.viewMode === "credentials" ? (
                <CredentialsPage activeRepoPath={activeRepo?.path ?? null} />
```

(Match the exact ternary/JSX shape already in App.tsx — insert alongside the `customize` branch. If the surrounding code uses `activeRepo?.path`, reuse that exact accessor.)

- [ ] **Step 3: Verify typecheck + renderer build**

Run: `cd packages/desktop && bunx tsc --noEmit && bun run build:renderer`
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add packages/desktop/src/renderer/App.tsx
git commit -m "feat(desktop): 凭证页接入 App view 路由"
```

---

## Task 11: renderer page render test (lock)

**Files:**
- Create: `packages/desktop/src/renderer/credentials/CredentialsPage.test.tsx`

- [ ] **Step 1: Write the test** (mock window.codeshell.credentials)

```tsx
// packages/desktop/src/renderer/credentials/CredentialsPage.test.tsx
import React from "react";
import { describe, test, expect, beforeEach } from "bun:test";
import { render, screen, cleanup } from "@testing-library/react";
import { CredentialsPage } from "./CredentialsPage";

describe("CredentialsPage", () => {
  beforeEach(() => {
    cleanup();
    (globalThis as any).window = (globalThis as any).window ?? {};
    (window as any).codeshell = {
      credentials: {
        list: async () => [],
        cookieDomains: async () => [],
        cookiePreview: async () => ({ count: 0 }),
        save: async () => {},
        remove: async () => {},
      },
      openBrowserPopout: () => {},
    };
  });

  test("renders three tabs and defaults to Cookie", () => {
    render(<CredentialsPage activeRepoPath={null} />);
    expect(screen.getByText("Cookie")).toBeDefined();
    expect(screen.getByText("Permission Token")).toBeDefined();
    expect(screen.getByText("Link")).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test**

Run: `cd packages/desktop && bun test src/renderer/credentials/CredentialsPage.test.tsx`
Expected: PASS. (If the repo's renderer tests use a different harness — check an existing `*.test.tsx` like `Markdown.test.tsx` for the exact render import — match it.)

- [ ] **Step 3: Commit**

```bash
git add packages/desktop/src/renderer/credentials/CredentialsPage.test.tsx
git commit -m "test(desktop): 凭证页 3 tab 渲染锁定"
```

---

## Task 12: MCP editor「使用凭证」绑定

**Files:**
- Modify: `packages/desktop/src/renderer/settings/McpSection.tsx`

- [ ] **Step 1: In the MCP edit form**, where `bearerTokenEnvVar` is edited, add a credential dropdown that sets `credentialRef`. Load token/link credentials via `window.codeshell.credentials.list(cwd)`. Use `SimpleSelect` from `@/components/ui/simple-select`:

```tsx
// near other auth fields; `server`/`setServer` are the existing edit-state accessors
<div className="space-y-1">
  <Label>使用凭证(可选,优先于 Bearer env)</Label>
  <SimpleSelect
    value={server.credentialRef ?? ""}
    options={[
      { label: "(不使用)", value: "" },
      ...credOptions, // [{label, value:id}] loaded from credentials.list, type token|link
    ]}
    onChange={(v) => setServer({ ...server, credentialRef: v || undefined })}
  />
</div>
```

Where `credOptions` is loaded in a `useEffect`:

```tsx
const [credOptions, setCredOptions] = useState<{ label: string; value: string }[]>([]);
useEffect(() => {
  void window.codeshell.credentials.list(cwd).then((all) =>
    setCredOptions(all.map((c) => ({ label: `${c.label} (${c.id})`, value: c.id }))),
  );
}, [cwd]);
```

Add `credentialRef?: string` to the local MCP server type used in McpSection (mirror the core field).

- [ ] **Step 2: Verify typecheck + build**

Run: `cd packages/desktop && bunx tsc --noEmit && bun run build:renderer`
Expected: succeeds.

- [ ] **Step 3: Commit**

```bash
git add packages/desktop/src/renderer/settings/McpSection.tsx
git commit -m "feat(desktop): MCP 编辑器加「使用凭证」绑定(credentialRef)"
```

---

## Task 13: wire MCP credentialRef resolution at connect time

**Files:**
- Modify: wherever `buildHttpHeaders` is called for MCP connection (grep in `packages/core/src/tool-system/mcp-manager.ts` for the call site, likely in connect/start).

- [ ] **Step 1: Find the call site** — grep `buildHttpHeaders(` in mcp-manager.ts (the connection path, not the export).

- [ ] **Step 2: Pass a resolver** backed by a CredentialStore for the current cwd:

```typescript
import { CredentialStore } from "../credentials/index.js";
// at the call site (the MCPManager should know its cwd; if not, thread it in):
const credStore = new CredentialStore(this.cwd);
const headers = buildHttpHeaders(serverName, config, (id) => credStore.resolve(id)?.secret);
```

If MCPManager has no `cwd`, check its constructor; thread cwd through from the Engine that creates it (grep `new MCPManager`). If threading cwd is too invasive, fall back to `new CredentialStore(undefined)` (user-scope only) and note it in the commit.

- [ ] **Step 3: Verify typecheck + targeted test**

Run: `cd packages/core && bunx tsc --noEmit && bun test src/tool-system/mcp-manager.test.ts`
Expected: passes.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/tool-system/mcp-manager.ts
git commit -m "feat(core): MCP 连接时用 CredentialStore 解析 credentialRef"
```

---

## Task 14: full verification + summary

- [ ] **Step 1: core full test**

Run: `cd packages/core && bun test src/credentials/ src/tool-system/mcp-manager.test.ts`
Expected: all pass.

- [ ] **Step 2: desktop typecheck + build + tests**

Run: `cd packages/desktop && bunx tsc --noEmit && bun run build:renderer && bun test src/main/credentials-service.test.ts src/renderer/credentials/`
Expected: all pass / build ok.

- [ ] **Step 3: core typecheck**

Run: `cd packages/core && bunx tsc --noEmit`
Expected: clean.

---

## Deferred (not in this plan — noted for the spec's §5 CredentialUseGate)

The unified **CredentialUseGate** (per-tool-call approval with 「本会话记住」 for cookie/token use, and the full Cookie Lease three-layer cleanup with env injection into a live Bash call) is the deepest piece and touches the tool executor + approval prompt UI. This plan delivers the store, the cookie capture/formatting + lease materialization primitives, the MCP binding, and the full UI. The runtime "AI asks to use credential X mid-task" approval flow is the natural next plan (Task set 15+), building on `createCookieLease`/`cleanupLease` already implemented here and the existing `InteractiveApprovalBackend`. Flagged so it isn't mistaken as done.
