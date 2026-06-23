# 手动 Catalog 编辑器(设置页「模型目录」)设计

**日期**: 2026-06-24
**状态**: 设计 / 待 review
**触发**: 用户要在设置页加一个手动配置 catalog 的地方 —— 先配 provider 再配其下 model,且 AI 用 editModelCatalog 加的条目用户也能在 UI 改。参考业界 AI 编辑器(Cline/Roo/Continue/Aider)做法。

---

## 1. 背景与现状

**现状**(已审计):
- `TextConnectionsPanel`(连接页)能让用户**选**现成 catalog 模板 + 填凭证 + 选 model + 调参数 + 设默认 —— 但**不能改模板本身**(provider 的 baseUrl/adapterKind、加新 model、改 params)。
- 改模板今天只能靠 **AI 的 editModelCatalog 工具**或**手改 `model-catalog.user.json`**。
- 数据三层:`CatalogEntry`(provider 模板)→ `modelPresets[]`(其下 models)→ 每 model 的 `params[]`(ParamSpec)。凭证(`credentials[]`)独立,连接(`modelConnections[]`)引用模板 + 凭证。
- 持久层 `saveCatalogEntry`(save-entry.ts)只支持 add/update,**无 delete**。IPC 只有 `catalog:list`,**无 save/delete**。

**业界调研结论**(deep-research,见附):没有一家用严格"先注册 provider 再挂 model"两层结构 —— UI 派(Cline/Roo)同屏分区表单,文件派(Continue/Aider)model-centric 扁平数组。**我们的三层分离(provider 模板 / models / 独立凭证)比业界任何一家都更结构化**,是差异化优势,设计应保留而非退化成 inline。借鉴:Cline/Roo 的同屏分区表单;Aider 的 `accepts_settings`(我们用 ParamSpec 驱动参数控件已对上)。

---

## 2. 范围(用户已拍板)

| 决策 | 结论 |
|---|---|
| 范围 | **全 CRUD** —— provider 模板 + 其下 model + 每 model 参数 |
| 内置模板 | **可改** —— 用户改内置时写 user.json 同 id 覆盖条(getMergedCatalog 已 user 覆盖 builtin) |
| 布局 | **可展开卡片(accordion)** —— 单栏纵向,和现有连接页卡片风格一致 |
| 生效 | **写盘即生效** —— 下条消息 getMergedCatalog/resolveLLMConfigForTag 重读自然拿新值,无需热重载 |
| 删除语义 | **自定义真删 / 内置重置** —— 用户自建条从 user.json 删除;被改过的内置条"重置"= 从 user.json 删覆盖条,退回代码内置版 |
| 位置 | **独立设置子页「模型目录」** —— 与连接页平级的新 tab |

**不在范围**:凭证管理(仍在连接页);连接实例管理(仍在连接页);AI editModelCatalog 工具(已存在,与本 UI 共用同一持久层)。

---

## 3. 架构

三层改动:**core 持久层补 delete → IPC 暴露 save/delete → renderer 新设置子页**。

### 3.1 Core 持久层(新增 deleteUserCatalogEntry)

`packages/core/src/model-catalog/save-entry.ts` 已有 `saveCatalogEntry(entry, {path, stamp})`(add/update,返回 `{ok, action, error, backup}`)。新增:

```typescript
/**
 * 从 user catalog 文件删除指定 id 的条目。
 * - 自定义条目:删除后该 id 在 merged catalog 消失。
 * - 内置条目的覆盖条:删除后退回代码内置版(getMergedCatalog 重新只取 builtin)。
 *   = UI 的"重置"语义。
 * 返回 { ok, removed: boolean, backup? }。removed=false 表示 user.json 本无此 id
 * (内置原版,无覆盖条可删 → UI 不该对未改过的内置条显示"重置")。
 */
export function deleteUserCatalogEntry(
  id: string,
  opts: { path: string; stamp: string },
): { ok: boolean; removed: boolean; error?: string; backup?: string };
```
实现:读 user.json → filter 掉 id → 备份 → 原子写。复用 saveCatalogEntry 的备份/原子写/容错模式。

### 3.2 判定"内置 vs 自定义 vs 已改内置"

UI 需要对每个 catalog 条目知道它的来源,才能正确显示「删除 / 重置」+ 标记「(改过)」。新增一个纯函数(core,供 IPC 计算):

```typescript
// packages/core/src/model-catalog/index.ts
export type CatalogEntryOrigin = "builtin" | "user" | "user-override-of-builtin";
/** 对 merged catalog 的每个 id,标注它来自哪:纯内置 / 纯用户自定义 / 用户覆盖了内置。 */
export function catalogEntryOrigins(): Record<string, CatalogEntryOrigin>;
```
实现:`builtinIds = BUILTIN_CATALOG.map(id)`;`userIds = loadUserCatalog().map(id)`。
- id ∈ user ∩ builtin → `user-override-of-builtin`(UI 显"(改过)"+「重置」)
- id ∈ user only → `user`(UI 显「删除」)
- id ∈ builtin only → `builtin`(UI 显「编辑」,无删除;一旦编辑保存就变 override)

### 3.3 IPC(暴露 save/delete/origins）

`packages/desktop/src/main/index.ts` 现有 `catalog:list`。新增:
```typescript
ipcMain.handle("catalog:save", async (_e, entry) =>
  saveCatalogEntry(entry, { path: userCatalogPath(), stamp: nowStamp() }));
ipcMain.handle("catalog:delete", async (_e, id: string) =>
  deleteUserCatalogEntry(id, { path: userCatalogPath(), stamp: nowStamp() }));
ipcMain.handle("catalog:origins", async () => catalogEntryOrigins());
```
preload(`index.ts` + `types.d.ts`)暴露:
```typescript
saveCatalogEntry: (entry) => ipcRenderer.invoke("catalog:save", entry),
deleteCatalogEntry: (id) => ipcRenderer.invoke("catalog:delete", id),
getCatalogOrigins: () => ipcRenderer.invoke("catalog:origins"),
// getModelCatalog 已存在
```

### 3.4 Renderer:新设置子页「模型目录」`ModelCatalogPanel.tsx`

挂在 SettingsView/SettingsPage 的新 tab(与「连接」平级)。布局 = 可展开卡片:

```
模型目录                                    [+ 新建 provider]
─────────────────────────────────────────────
▸ openai          OpenAI API · 3 models · 内置
▾ zhipu           Zhipu GLM · 2 models · (改过) [重置]
    ┌─ provider 基础字段(编辑表单)──────────┐
    │ displayName  [Zhipu GLM            ]    │
    │ adapterKind  [openai ▾]  protocol [openai-compat ▾] │
    │ baseUrl      [https://open.bigmodel.cn/...]         │
    │ needsKey     [✓]   tag [text ▾]                     │
    ├─ MODELS ────────────────────────────────┤
    │ glm-5.2   ctx 1M · 5 params      [✎][🗑] │
    │ glm-4.6   ctx 200k               [✎][🗑] │
    │ [+ 加 model]                             │
    └──────────────────────────────────────────┘
    [保存]  [取消]
▸ deepseek        DeepSeek · 2 models · 内置
─────────────────────────────────────────────
```

- **provider 卡片**:折叠态显 displayName + model 数 + 来源标记(内置 / (改过) / 自定义)。展开 → 基础字段表单 + model 子列表。
- **基础字段**:displayName / description / tag(enum) / adapterKind(enum:openai|anthropic|google|fal|...) / protocol(enum) / baseUrl / defaultModel / needsKey(toggle) / signupUrl。
- **model 子列表**:每 model 一行(id + ctx + param 数 + 编辑/删除)。「加 model」「编辑 model」打开 model 编辑弹窗(DialogProvider 的 prompt 风格或内联展开):value(id) / label / maxContextTokens / maxOutputTokens / supportsVision / **params[]**(ParamSpec 编辑器)。
- **params[] 编辑**:每个 param = name / label / control(enum|number|toggle|text) / options(control=enum) / min/max(number) / default / doc / wire.field。这是最深一层,复用一个小的 ParamSpec 行编辑器。
- **保存**:整条 CatalogEntry → `saveCatalogEntry` IPC。内置条首次保存 → 变 override(自动)。
- **删除/重置**:自定义 → `deleteCatalogEntry`;override-of-builtin → 同 IPC(删覆盖条)但按钮文案「重置」+ 确认提示「将退回内置版本」。纯内置无删除按钮。
- **反馈**:用 DialogProvider(useConfirm 删除确认)+ ToastProvider(保存/删除成功)。复用现有 ParamControls 的 control 类型枚举。
- **刷新**:保存/删除后重新 `getModelCatalog` + `getCatalogOrigins`;监听 `codeshell:files-changed`(和连接页一致)。

### 3.5 与连接页的关系

模型目录编**模板**;连接页用**模板建实例 + 绑凭证**。两页解耦:在模型目录加了 provider/model 后,去连接页就能选到它建连接。凭证永远在连接页 / credentials,模型目录不碰 key。

---

## 4. 文件结构

| 文件 | 改动 |
|---|---|
| `packages/core/src/model-catalog/save-entry.ts` | 新增 `deleteUserCatalogEntry` |
| `packages/core/src/model-catalog/index.ts` | 新增 `catalogEntryOrigins` |
| `packages/desktop/src/main/index.ts` | 新增 `catalog:save` / `catalog:delete` / `catalog:origins` IPC |
| `packages/desktop/src/preload/index.ts` + `types.d.ts` | 暴露 saveCatalogEntry/deleteCatalogEntry/getCatalogOrigins |
| `packages/desktop/src/renderer/settings/ModelCatalogPanel.tsx` | **新建** 主面板(可展开卡片) |
| `packages/desktop/src/renderer/settings/catalogEditor.ts` | **新建** 纯逻辑(空白条目模板、校验前处理、origin→按钮映射) |
| `packages/desktop/src/renderer/settings/ModelEditDialog.tsx` | **新建** model + params 编辑弹窗(或内联组件) |
| `packages/desktop/src/renderer/settings/SettingsView.tsx` / `SettingsPage.tsx` | 加「模型目录」tab |
| i18n ns 文件 | 加文案 key(zh + en) |

---

## 5. 错误处理

- **校验**:保存走 `saveCatalogEntry` 已有的 zod 校验(catalogEntrySchema);UI 侧对必填(id/tag/adapterKind/baseUrl)做即时提示,避免提交才报错。
- **id 冲突**:新建 provider 时 id 已存在 → 提示(否则会覆盖)。saveCatalogEntry 是 upsert,UI 要在"新建"语境区分 add vs 误覆盖。
- **删除确认**:useConfirm;override 重置文案明确"退回内置"。
- **写失败**:IPC 返回 `{ok:false, error}` → toast 报错,不静默。
- **正在被连接引用的模板被删/改 id**:删 provider 模板后,引用它的连接会变悬空(resolveInstance 返回 null → 连接页那条不可用)。**本设计不级联删连接**(连接是用户数据),但保存/删除后可加一句提示"N 个连接引用此模板"。MVP 可只提示不阻断。

---

## 6. 测试策略(TDD)

1. **deleteUserCatalogEntry** 单测:删自定义条(removed=true、merged 消失);删 override 条(removed=true、merged 退回 builtin);删不存在的(removed=false);备份生成;原子写。
2. **catalogEntryOrigins** 单测:builtin-only→builtin;user-only→user;交集→user-override-of-builtin。
3. **save→delete 往返**:保存一个 override 内置条 → origins 变 user-override → 删 → origins 退回 builtin、merged 是内置原版。
4. **catalogEditor.ts** 纯逻辑单测:空白模板、origin→按钮映射、id 冲突判定。
5. **IPC** 冒烟:catalog:save/delete/origins 端到端(若 desktop 有 IPC 测试夹具;否则手动)。
6. **renderer 组件**:按现有 desktop 组件测试惯例(若有);否则真机冒烟覆盖。
7. 改 core 必 rebuild(dist 消费者)。

---

## 7. 风险

| 风险 | 缓解 |
|---|---|
| catalogEntrySchema 严格,UI 拼的条目缺字段被拒 | UI 用空白模板预填默认 + 即时校验必填;保存前本地校验 |
| 删模板致连接悬空 | resolveInstance 已返回 null(不崩);保存/删除提示引用数;不级联 |
| params[] 编辑器是最深一层,易做复杂 | MVP params 编辑器只覆盖 name/control/options/default/wire.field;doc/min/max 进阶可折叠 |
| adapterKind 枚举写死在 UI | 从 provider-kinds 取枚举(core 已有 ProviderKindName),不在 UI 重列 |
| 内置条改坏(用户填错 baseUrl)→ 模型不可用 | 有「重置」退路;不可逆风险低 |

---

## 8. 验收标准

- [ ] 设置页有「模型目录」tab,列出全部 merged catalog 条目,标来源(内置/改过/自定义)
- [ ] 能新建 provider 模板(填基础字段)→ 保存 → 连接页能选到
- [ ] 能给任意 provider 加/改/删 model + 其参数
- [ ] 能改内置模板(保存后变"改过",可"重置"退回内置)
- [ ] 能删自定义模板
- [ ] 保存后下条消息即用新 catalog(无需重启)
- [ ] 凭证仍只在连接页管,模型目录不碰 key
- [ ] core 单测覆盖 delete/origins;三包 typecheck 0 新错

---

## 附:业界调研要点(deep-research 2026-06-24)

- **无严格两层**:UI 派(Cline/Roo)同屏分区表单选 "OpenAI Compatible" + 填 baseUrl/key/model;文件派(Continue/Aider)model-centric 数组,provider 只是 model 上的 adapter 枚举字段。
- **自定义端点**:都是 baseUrl + key + model id 三件套(UI 派同屏填,文件派 model 条目加 apiBase)。
- **model 参数**:都挂 per-model(context/maxTokens/temperature/reasoning/定价/能力位)。
- **内置模板概念**:业界**没有**可复用、可改写的 provider 记录 → 我们的 CatalogEntry 模板更结构化。
- **凭证**:Continue inline(同 provider 多 model 重复 key)、Aider 完全分离(env/conf)、Roo 入 OS Secret Storage 随 profile。**我们独立 credentials + 连接引用**最干净。
- **借鉴**:Aider 的 `accepts_settings`(per-model 声明支持哪些 reasoning 参数)≈ 我们 ParamSpec 驱动控件渲染,已对上。
