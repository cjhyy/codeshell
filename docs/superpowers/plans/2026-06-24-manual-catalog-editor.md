# 手动 Catalog 编辑器实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development 或 executing-plans。步骤用 `- [ ]` 勾选。

**Goal:** 在设置页加一个「模型目录」子页,让用户手动对 provider 模板(CatalogEntry)+ 其下 model(modelPresets)+ 参数做全 CRUD;内置模板可改(写 user.json 覆盖)/重置;AI 用 editModelCatalog 加的也能在此改。

**Architecture:** 三层 —— core 持久层补 `deleteUserCatalogEntry` + `catalogEntryOrigins`;desktop IPC 暴露 catalog save/delete/origins;renderer 新建可展开卡片面板 `ModelCatalogPanel`。catalog 写盘后下条消息经 getMergedCatalog 重读自然生效,无需热重载。凭证不在此管(仍在连接页)。

**Tech Stack:** TypeScript,bun test,zod(catalogEntrySchema 已存在),Electron IPC,React + shadcn(desktop renderer),i18n(zh+en)。

**设计稿:** `docs/superpowers/specs/2026-06-24-manual-catalog-editor-design.md`

---

## 关键事实(实现前必读)

1. **`saveCatalogEntry(entry, {path, stamp})`**(`model-catalog/save-entry.ts`)已存在:zod 校验 + 备份 + upsert 原子写,返回 `{ok, action:"added"|"updated", error?, backup?}`。**无 delete**。
2. **catalog 来源**:`getMergedCatalog()` = `BUILTIN_CATALOG` ∪ `loadUserCatalog()`(user 覆盖 builtin,by id)。`userCatalogPath()` = `~/.code-shell/model-catalog.user.json`。`userCatalogFileSchema` = `z.array(catalogEntrySchema)`。全部从 `model-catalog/index.ts` 导出。
3. **CatalogEntry shape**(`model-catalog/types.ts`):`{id, tag, adapterKind, protocol?, shape?, displayName, description, defaultBaseUrl, defaultModel?, needsKey?, modelPresets?: ModelPreset[], signupUrl?, test?, paramsDoc?}`。ModelPreset:`{value, label?, maxContextTokens?, maxOutputTokens?, supportsVision?, params?: ParamSpec[]}`。ParamSpec:`{name, label?, control:"enum"|"number"|"toggle"|"text", options?, min?, max?, default?, doc?, wire?:{field}}`。
4. **IPC 现状**:`packages/desktop/src/main/index.ts:1445` 有 `ipcMain.handle("catalog:list", () => getMergedCatalog())`。preload `index.ts:572` 有 `getModelCatalog: () => ipcRenderer.invoke("catalog:list")`。**无 save/delete/origins**。
5. **SettingsView**(`renderer/settings/SettingsView.tsx`):`type Tab = "model"|"permission"|"mcp"|"update"|"json"`(line 15),tab 数组在 line 94,render switch line 110+,标题映射 line 25。加 tab 改这几处。
6. **改 core 必 rebuild**(dist 消费者)。测试 `bun test`(import `from "bun:test"`)。desktop 有独立 typecheck。
7. **走 worktree,不碰 main。** MVP params 编辑器只做 name/control/options/default/wire.field(doc/min/max 折叠进阶)。删模板不级联删连接,只提示引用数。

---

## 文件结构

| 文件 | 责任 | 动作 |
|---|---|---|
| `packages/core/src/model-catalog/save-entry.ts` | 加 `deleteUserCatalogEntry` | 改 |
| `packages/core/src/model-catalog/index.ts` | 加 `catalogEntryOrigins` | 改 |
| `packages/core/src/model-catalog/save-entry.test.ts` | delete 单测 | 新建/改 |
| `packages/core/src/model-catalog/origins.test.ts` | origins 单测 | 新建 |
| `packages/desktop/src/main/index.ts` | catalog:save/delete/origins IPC | 改 |
| `packages/desktop/src/preload/index.ts` + `types.d.ts` | 暴露 3 个方法 | 改 |
| `packages/desktop/src/renderer/settings/catalogEditor.ts` | 纯逻辑(空白模板/origin→按钮/校验) | 新建 |
| `packages/desktop/src/renderer/settings/catalogEditor.test.ts` | 纯逻辑单测 | 新建 |
| `packages/desktop/src/renderer/settings/ModelCatalogPanel.tsx` | 主面板(可展开卡片) | 新建 |
| `packages/desktop/src/renderer/settings/SettingsView.tsx` | 加「模型目录」tab | 改 |
| desktop i18n ns(settings) | 文案 key(zh+en) | 改 |

---

## Task 1: core — deleteUserCatalogEntry

**Files:** `model-catalog/save-entry.ts`、`model-catalog/save-entry.test.ts`

- [ ] **Step 1: 写失败测试**

在 `packages/core/src/model-catalog/save-entry.test.ts`(若无则新建,import 风格照同目录其它测试)追加:
```typescript
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deleteUserCatalogEntry } from "./save-entry.js";

describe("deleteUserCatalogEntry", () => {
  let dir: string; let path: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "cat-del-")); path = join(dir, "model-catalog.user.json"); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("removes an existing entry and reports removed:true", () => {
    writeFileSync(path, JSON.stringify([
      { id: "a", tag: "text", adapterKind: "openai", displayName: "A", description: "", defaultBaseUrl: "u" },
      { id: "b", tag: "text", adapterKind: "openai", displayName: "B", description: "", defaultBaseUrl: "u" },
    ]));
    const r = deleteUserCatalogEntry("a", { path, stamp: "t1" });
    expect(r.ok).toBe(true);
    expect(r.removed).toBe(true);
    const left = JSON.parse(readFileSync(path, "utf-8"));
    expect(left.map((e: any) => e.id)).toEqual(["b"]);
  });

  it("reports removed:false when id absent (no-op)", () => {
    writeFileSync(path, JSON.stringify([{ id: "a", tag: "text", adapterKind: "openai", displayName: "A", description: "", defaultBaseUrl: "u" }]));
    const r = deleteUserCatalogEntry("nope", { path, stamp: "t2" });
    expect(r.ok).toBe(true);
    expect(r.removed).toBe(false);
  });

  it("reports removed:false when file absent", () => {
    const r = deleteUserCatalogEntry("a", { path: join(dir, "missing.json"), stamp: "t3" });
    expect(r.ok).toBe(true);
    expect(r.removed).toBe(false);
  });

  it("backs up before writing", () => {
    writeFileSync(path, JSON.stringify([{ id: "a", tag: "text", adapterKind: "openai", displayName: "A", description: "", defaultBaseUrl: "u" }]));
    const r = deleteUserCatalogEntry("a", { path, stamp: "t4" });
    expect(r.backup).toBe(`${path}.bak-t4`);
    expect(existsSync(r.backup!)).toBe(true);
  });
});
```

- [ ] **Step 2: 跑确认失败** — `cd packages/core && bun test src/model-catalog/save-entry.test.ts`(deleteUserCatalogEntry 未定义)

- [ ] **Step 3: 实现** — 在 `save-entry.ts` 末尾加:
```typescript
export interface DeleteCatalogResult {
  ok: boolean;
  removed: boolean;
  error?: string;
  backup?: string;
}

/**
 * Remove the entry with `id` from the user catalog file. Mirrors saveCatalogEntry's
 * backup + atomic-write safety. removed:false means the id wasn't in the user file
 * (a pristine built-in entry, or simply absent) — caller decides UX (no "reset" to
 * offer). The built-in catalog is code, untouched — deleting a user override just
 * lets getMergedCatalog fall back to the built-in version ("reset" semantics).
 */
export function deleteUserCatalogEntry(
  id: string,
  opts: { path: string; stamp: string },
): DeleteCatalogResult {
  if (!existsSync(opts.path)) return { ok: true, removed: false };
  let backup: string | undefined = `${opts.path}.bak-${opts.stamp}`;
  try { copyFileSync(opts.path, backup); } catch { backup = undefined; }
  let current: CatalogEntry[] = [];
  try {
    const raw = JSON.parse(readFileSync(opts.path, "utf-8"));
    const safe = userCatalogFileSchema.safeParse(raw);
    current = safe.success ? safe.data : [];
  } catch { current = []; }
  const next = current.filter((e) => e.id !== id);
  const removed = next.length !== current.length;
  if (!removed) return { ok: true, removed: false, backup };
  try {
    writeFileSync(opts.path, JSON.stringify(next, null, 2));
  } catch (e) {
    return { ok: false, removed: false, error: `could not write catalog: ${e instanceof Error ? e.message : String(e)}`, backup };
  }
  return { ok: true, removed: true, backup };
}
```
(imports `copyFileSync/readFileSync/writeFileSync/existsSync`、`userCatalogFileSchema`、`CatalogEntry` 都已在文件顶部 import —— 确认,saveCatalogEntry 用了同一批。)

- [ ] **Step 4: 跑确认通过** — `cd packages/core && bun test src/model-catalog/save-entry.test.ts`(全绿)

- [ ] **Step 5: 提交**
```bash
cd <worktree>
git add packages/core/src/model-catalog/save-entry.ts packages/core/src/model-catalog/save-entry.test.ts
git commit -m "feat(core): deleteUserCatalogEntry — 从 user catalog 删条目(自定义真删/内置覆盖重置)"
```

---

## Task 2: core — catalogEntryOrigins

**Files:** `model-catalog/index.ts`、`model-catalog/origins.test.ts`

- [ ] **Step 1: 写失败测试** — `packages/core/src/model-catalog/origins.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { catalogEntryOrigins, BUILTIN_CATALOG } from "./index.js";

describe("catalogEntryOrigins", () => {
  let home: string; let prevHome: string | undefined;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "cat-orig-"));
    prevHome = process.env.HOME; process.env.HOME = home;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("marks a builtin id as builtin when no user override", () => {
    const o = catalogEntryOrigins();
    const someBuiltin = BUILTIN_CATALOG[0].id;
    expect(o[someBuiltin]).toBe("builtin");
  });

  it("marks a user-only id as user", () => {
    writeFileSync(join(home, ".code-shell", "model-catalog.user.json"),
      JSON.stringify([{ id: "my-custom", tag: "text", adapterKind: "openai", displayName: "Mine", description: "", defaultBaseUrl: "u" }]),
    );
    // mkdir parent first:
    // (handled below — see note)
    const o = catalogEntryOrigins();
    expect(o["my-custom"]).toBe("user");
  });

  it("marks an overridden builtin id as user-override-of-builtin", () => {
    const builtinId = BUILTIN_CATALOG[0].id;
    writeFileSync(join(home, ".code-shell", "model-catalog.user.json"),
      JSON.stringify([{ id: builtinId, tag: "text", adapterKind: "openai", displayName: "Overridden", description: "", defaultBaseUrl: "u" }]),
    );
    const o = catalogEntryOrigins();
    expect(o[builtinId]).toBe("user-override-of-builtin");
  });
});
```
> 注:测试写 user.json 前需 `mkdirSync(join(home,".code-shell"),{recursive:true})`。实现测试时在每个 writeFileSync 前补这行(userHome() 读 process.env.HOME,已验证)。

- [ ] **Step 2: 跑确认失败** — `cd packages/core && bun test src/model-catalog/origins.test.ts`

- [ ] **Step 3: 实现** — 在 `model-catalog/index.ts` 末尾加:
```typescript
export type CatalogEntryOrigin = "builtin" | "user" | "user-override-of-builtin";

/**
 * Per-id provenance of the merged catalog: pure built-in, pure user-added, or a
 * user override of a built-in. Lets the editor UI show 编辑/删除/重置 correctly
 * (only an override can be "reset"; only a user-only entry can be truly deleted).
 */
export function catalogEntryOrigins(): Record<string, CatalogEntryOrigin> {
  const builtinIds = new Set(BUILTIN_CATALOG.map((e) => e.id));
  const userIds = new Set(loadUserCatalog().map((e) => e.id));
  const out: Record<string, CatalogEntryOrigin> = {};
  for (const id of builtinIds) out[id] = userIds.has(id) ? "user-override-of-builtin" : "builtin";
  for (const id of userIds) if (!builtinIds.has(id)) out[id] = "user";
  return out;
}
```

- [ ] **Step 4: 跑确认通过 + rebuild** — `cd packages/core && bun test src/model-catalog/ && bun run build`

- [ ] **Step 5: 提交**
```bash
git add packages/core/src/model-catalog/index.ts packages/core/src/model-catalog/origins.test.ts
git commit -m "feat(core): catalogEntryOrigins — 标注每个 catalog 条目来源(内置/用户/覆盖)"
```

---

## Task 3: desktop IPC + preload 暴露 catalog save/delete/origins

**Files:** `main/index.ts`、`preload/index.ts`、`preload/types.d.ts`

- [ ] **Step 1: 加 IPC handler** — `packages/desktop/src/main/index.ts`,在 `catalog:list`(line ~1445)附近加:
```typescript
ipcMain.handle("catalog:save", async (_e, entry: unknown) =>
  saveCatalogEntry(entry, { path: userCatalogPath(), stamp: String(Date.now()) }));
ipcMain.handle("catalog:delete", async (_e, id: string) =>
  deleteUserCatalogEntry(id, { path: userCatalogPath(), stamp: String(Date.now()) }));
ipcMain.handle("catalog:origins", async () => catalogEntryOrigins());
```
确认顶部 import 含 `saveCatalogEntry, deleteUserCatalogEntry, userCatalogPath, catalogEntryOrigins`(从 `@cjhyy/code-shell-core` 或对应子路径 —— 看 catalog:list 现在怎么 import getMergedCatalog,照它加)。`Date.now()` 在 desktop main 进程允许(非 core/workflow 限制路径)。

- [ ] **Step 2: preload 暴露** — `packages/desktop/src/preload/index.ts`(getModelCatalog 旁 line ~572)加:
```typescript
saveCatalogEntry: (entry: unknown) => ipcRenderer.invoke("catalog:save", entry),
deleteCatalogEntry: (id: string) => ipcRenderer.invoke("catalog:delete", id),
getCatalogOrigins: () => ipcRenderer.invoke("catalog:origins"),
```

- [ ] **Step 3: 类型** — `packages/desktop/src/preload/types.d.ts`,在 codeshell API 接口里(getModelCatalog 旁)加:
```typescript
saveCatalogEntry: (entry: unknown) => Promise<{ ok: boolean; action?: "added" | "updated"; error?: string; backup?: string }>;
deleteCatalogEntry: (id: string) => Promise<{ ok: boolean; removed: boolean; error?: string; backup?: string }>;
getCatalogOrigins: () => Promise<Record<string, "builtin" | "user" | "user-override-of-builtin">>;
```

- [ ] **Step 4: rebuild core(IPC import 走 dist)+ desktop typecheck**
```bash
cd packages/core && bun run build
cd ../desktop && bunx tsc --noEmit -p . 2>&1 | grep -v code-shell-cdp | tail -5
```
Expected: 无新错(允许预存 cdp 错)

- [ ] **Step 5: 提交**
```bash
git add packages/desktop/src/main/index.ts packages/desktop/src/preload/index.ts packages/desktop/src/preload/types.d.ts
git commit -m "feat(desktop): catalog save/delete/origins IPC + preload 暴露"
```

---

## Task 4: renderer 纯逻辑 catalogEditor.ts

**Files:** `renderer/settings/catalogEditor.ts`、`catalogEditor.test.ts`

- [ ] **Step 1: 写失败测试** — `packages/desktop/src/renderer/settings/catalogEditor.test.ts`:
```typescript
import { describe, it, expect } from "bun:test";
import { blankCatalogEntry, deleteAction, validateEntry } from "./catalogEditor.js";

describe("catalogEditor", () => {
  it("blankCatalogEntry produces a minimal valid-shaped text entry", () => {
    const e = blankCatalogEntry("text");
    expect(e.tag).toBe("text");
    expect(e.id).toBe("");
    expect(e.adapterKind).toBe("openai");
    expect(e.modelPresets).toEqual([]);
    expect(e.needsKey).toBe(true);
  });

  it("deleteAction maps origin → button kind", () => {
    expect(deleteAction("user")).toBe("delete");
    expect(deleteAction("user-override-of-builtin")).toBe("reset");
    expect(deleteAction("builtin")).toBe("none");
  });

  it("validateEntry catches missing required fields", () => {
    expect(validateEntry(blankCatalogEntry("text")).length).toBeGreaterThan(0); // empty id/baseUrl
    const ok = { ...blankCatalogEntry("text"), id: "x", displayName: "X", defaultBaseUrl: "https://u/v1" };
    expect(validateEntry(ok)).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑确认失败** — `cd packages/desktop && bun test src/renderer/settings/catalogEditor.test.ts`
> 注:确认 desktop 用 bun test。若 desktop 测试用别的 runner(vitest),按 desktop 现有测试文件的 import/runner 调整(读一个现成的 `.test.ts` 确认)。

- [ ] **Step 3: 实现** — `packages/desktop/src/renderer/settings/catalogEditor.ts`:
```typescript
import type { CatalogEntry } from "@cjhyy/code-shell-core";

export type CatalogEntryOrigin = "builtin" | "user" | "user-override-of-builtin";

/** A fresh, minimal entry for the "新建 provider" flow. id/displayName/baseUrl
 *  are filled by the user; needsKey defaults true; no models yet. */
export function blankCatalogEntry(tag: CatalogEntry["tag"]): CatalogEntry {
  return {
    id: "", tag, adapterKind: "openai", protocol: "openai-compat",
    displayName: "", description: "", defaultBaseUrl: "", needsKey: true,
    modelPresets: [],
  } as CatalogEntry;
}

/** Which destructive button an entry shows, from its origin. */
export function deleteAction(origin: CatalogEntryOrigin): "delete" | "reset" | "none" {
  if (origin === "user") return "delete";
  if (origin === "user-override-of-builtin") return "reset";
  return "none"; // pristine builtin — no delete
}

/** Lightweight required-field check before save (the real zod validation runs
 *  in saveCatalogEntry; this gives instant UI feedback). Returns error messages. */
export function validateEntry(e: CatalogEntry): string[] {
  const errs: string[] = [];
  if (!e.id?.trim()) errs.push("id 必填");
  if (!e.displayName?.trim()) errs.push("显示名必填");
  if (!e.defaultBaseUrl?.trim()) errs.push("baseUrl 必填");
  if (!e.adapterKind?.trim()) errs.push("adapterKind 必填");
  return errs;
}
```

- [ ] **Step 4: 跑确认通过** — `cd packages/desktop && bun test src/renderer/settings/catalogEditor.test.ts`

- [ ] **Step 5: 提交**
```bash
git add packages/desktop/src/renderer/settings/catalogEditor.ts packages/desktop/src/renderer/settings/catalogEditor.test.ts
git commit -m "feat(desktop): catalogEditor 纯逻辑(空白模板/origin→按钮/校验)"
```

---

## Task 5: renderer ModelCatalogPanel(可展开卡片主面板)

**Files:** `renderer/settings/ModelCatalogPanel.tsx`(新建)

> 这是最大的一块 UI。无独立单测(渲染组件按 desktop 惯例靠真机冒烟 + 纯逻辑已在 Task 4 覆盖)。按现有 `TextConnectionsPanel.tsx` 的结构/hook/shadcn 用法照搬骨架。

- [ ] **Step 1: 读现有面板取模式** — 读 `packages/desktop/src/renderer/settings/TextConnectionsPanel.tsx` 前 ~120 行 + `connUi.tsx`,确认:settingsCache/refresh 模式、useT、useConfirm/useToast、ConnCard/ConnField/SimpleSelect/Switch、`useRefreshOnSettingsChange`。ModelCatalogPanel 复用同款。

- [ ] **Step 2: 写面板骨架** — `ModelCatalogPanel.tsx`:
  - 顶部:标题 + 「+ 新建 provider」按钮。
  - state:`entries: CatalogEntry[]`(来自 `getModelCatalog()`)、`origins: Record<string,Origin>`(来自 `getCatalogOrigins()`)、`expandedId: string | null`、`draft: CatalogEntry | null`(正在编辑的副本)。
  - load:`const [c, o] = await Promise.all([codeshell.getModelCatalog(), codeshell.getCatalogOrigins()])`;`useRefreshOnSettingsChange(load)`。
  - 列表:每个 entry 一张可折叠卡片。折叠头:`displayName` + `${modelPresets?.length??0} models` + origin 标记(builtin→"内置" / user→"自定义" / override→"(改过)")。点击切换 expandedId。
  - 展开体:基础字段表单(displayName/description/tag SimpleSelect/adapterKind SimpleSelect(从 core ProviderKindName 取枚举)/protocol SimpleSelect/defaultBaseUrl/defaultModel/needsKey Switch/signupUrl)绑到 draft;model 子列表(每行 value + ctx + `${params?.length??0} params` + 编辑/删除按钮);「+ 加 model」。
  - model 编辑:内联展开或弹窗(MVP 可内联):value/label/maxContextTokens/maxOutputTokens/supportsVision + params 列表(每 param:name / control SimpleSelect / options(control=enum,逗号分隔输入)/ default / wire.field;MVP doc/min/max 折进「进阶」)。
  - 保存:`validateEntry(draft)` 有错→toast 报错不提交;否则 `await codeshell.saveCatalogEntry(draft)` → 检查 `{ok}` → toast 成功/失败 → reload。
  - 删除/重置:`deleteAction(origins[id])` 决定按钮:`delete`→useConfirm「删除模板?」、`reset`→useConfirm「重置为内置版本?」、`none`→不显示。确认后 `await codeshell.deleteCatalogEntry(id)` → toast → reload。
  - 引用提示(可选 MVP):保存/删除时不计算引用数也可;若易加,从 settings.modelConnections 数引用此 catalogId 的连接数,删除确认里带一句。**MVP 可省**。

  完整代码按 TextConnectionsPanel 的具体 import/组件照写(实现时对照那个文件,保持 import 路径、shadcn 组件名、i18n key 风格一致)。

- [ ] **Step 3: typecheck** — `cd packages/desktop && bunx tsc --noEmit -p . 2>&1 | grep -v code-shell-cdp | tail`(无新错)

- [ ] **Step 4: 提交**
```bash
git add packages/desktop/src/renderer/settings/ModelCatalogPanel.tsx
git commit -m "feat(desktop): ModelCatalogPanel — 可展开卡片的 catalog 编辑面板"
```

---

## Task 6: 挂进设置页 + i18n

**Files:** `SettingsView.tsx`、desktop settings i18n ns

- [ ] **Step 1: 加 tab** — `SettingsView.tsx`:
  - line 15 Tab 类型加 `"catalog"`:`type Tab = "model" | "catalog" | "permission" | "mcp" | "update" | "json"`
  - line 25 附近标题映射加 `case "catalog": return t("settingsX.view.tabCatalog");`
  - line 94 tab 数组加 `"catalog"`(放 "model" 之后)
  - line 110 附近 render 加 `{tab === "catalog" && <ModelCatalogPanel scope={scope} activeRepoPath={activeRepoPath} />}`
  - 顶部 import `ModelCatalogPanel`
  - props 与 TextConnectionsPanel 一致(scope/activeRepoPath)

- [ ] **Step 2: i18n** — 在 desktop settings ns(zh + en 两棵树,加 key 必两边都加 —— 见记忆 project_desktop_i18n):
  - `settingsX.view.tabCatalog`: zh "模型目录" / en "Model Catalog"
  - ModelCatalogPanel 用到的所有文案 key(标题/按钮/字段标签/确认文案/toast)同样 zh+en 补齐。

- [ ] **Step 3: rebuild + typecheck 全** — 
```bash
cd packages/core && bun run build
cd ../desktop && bunx tsc --noEmit -p . 2>&1 | grep -v code-shell-cdp | tail
```
Expected: 0 新错(TranslationKey 从 zh 树推导,漏 en 会类型报错 → 据此补全)

- [ ] **Step 4: 提交**
```bash
git add packages/desktop/src/renderer/settings/SettingsView.tsx packages/desktop/src/renderer/i18n/
git commit -m "feat(desktop): 设置页加「模型目录」tab + i18n"
```

---

## Task 7: 端到端验证 + 真机冒烟

**Files:** 无(验证)

- [ ] **Step 1: 全量** — `cd packages/core && bun run build && bun test src/`(0 fail);desktop typecheck 0 新错。
- [ ] **Step 2: core 往返验证**(脚本,不启 app):saveCatalogEntry 写一个 override 内置条 → catalogEntryOrigins 该 id 变 `user-override-of-builtin` → getMergedCatalog 该条是用户版 → deleteUserCatalogEntry 删 → origins 退回 `builtin`、getMergedCatalog 退回内置版。
- [ ] **Step 3: 真机冒烟**(worktree 跑 desktop,需 cdp 包先 build):
  - 打开设置 →「模型目录」tab → 列出所有 provider + 来源标记
  - 新建一个 provider(填 id/displayName/baseUrl)→ 保存 → 连接页能选到
  - 给它加一个 model + 参数 → 保存
  - 改一个内置(如 deepseek)→ 变"(改过)" → 重置 → 退回内置
  - 删自定义 provider
  记录每项结果。
- [ ] **Step 4: 提交收尾 + 合并**(走 finishing-a-development-branch:rebase 到最新 main → 验证 → 合)

---

## Self-Review 结果

- **Spec 覆盖**:§3.1 deleteUserCatalogEntry→T1;§3.2 catalogEntryOrigins→T2;§3.3 IPC→T3;§3.4 面板→T4(逻辑)+T5(UI);位置 tab→T6;生效(写盘)=getMergedCatalog 重读,无需代码(T7 验证);删除语义(自定义删/内置重置)→T1+T4 deleteAction+T5 按钮;凭证不碰→T5 不含 key 字段。全覆盖。
- **占位符**:T1-T4 代码完整。T5 是 UI 大组件,标注"照 TextConnectionsPanel 照写"——这是合理的实现期模式参照(无法预先写死整个 React 组件的每行,但骨架/state/调用/交互都列明)。非占位符式偷懒。
- **类型一致**:`CatalogEntryOrigin` 三值在 core(index.ts)/preload(types.d.ts)/renderer(catalogEditor.ts)一致;`deleteUserCatalogEntry` 返回 `{ok,removed,error?,backup?}` 在 T1 定义、T3 IPC 类型、T3 preload 类型一致;`saveCatalogEntry` 沿用现有 `{ok,action,error?,backup?}`。
- **风险记**:T5 是最大不确定项(UI 组件无单测),靠 T7 真机冒烟兜底;params 编辑器 MVP 子集已在 spec/plan 标明。
