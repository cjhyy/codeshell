# 面板应用项目绑定 UX 优化

日期：2026-07-30
状态：设计已确认，待实现

## 背景

commit `70d615f4` 给面板应用引入了真正的按项目绑定（`panelAppBindings: string[]`，
项目设置，默认全关）。数据模型是对的，但 UI 没跟上：

- **扩展 → 面板应用**只能操作**当前激活的项目**。页面顶部一条只读横幅写着
  「当前绑定项目：X」，没有任何选择器。想改别的项目，得先去侧栏把整个激活项目切过去。
- 每张卡片有**两个开关**（「绑定当前项目」+「全局总开关」），语义是
  `启用 = 项目已绑定 && 全局未禁用`。两个开关同时存在会产生矛盾状态：全局关掉后，
  项目侧仍显示已勾选但不生效。
- **设置 → 能力总览**（`CapabilitiesOverviewSection`）已经实现了「选一个项目、
  看它开了哪些能力」的形态，但面板应用完全不在这个列表里。

用户反馈原话：「当前面板的项目绑定和数字人的项目绑定体验都不是很好，没法切换项目，
把那一个绑定到什么上面都不是很 work」。

### 与 Skill 的关系（一个需要纠正的前提）

用户提出「就和 skill 的打开逻辑差不多」。需要说明：**Skill 的开关其实不是按项目的**。
`SkillsTab` 写的是 user 级的 `disabledSkills`，全局生效；`ManagePage.tsx:133-145`
那个「改动全局生效」灰色徽章就是在为此道歉（注释记录了用户反复以为在改项目级的反馈）。

所以本设计采用的是 Skill 的**交互形态**（一个列表、一行一个两态开关、点一下就完事），
而非它的 scope 语义。面板应用在 scope 粒度上本来就比 Skill 先进，不做降级。

### 不在本次范围内

**数字人（Digital Human）**。用户明确表示「数字人需要优化的地方很多，我后面单独优化」。

需要记录的事实，供后续那一轮参考：数字人**没有**按项目绑定这一层。它只有两种绑定，
都不是项目↔数字人的多对多关系：

| 绑定 | 存储位置 | 形状 |
| --- | --- | --- |
| 会话绑定 | session `state.json` → `workspaceProfile` | 单个字符串，只对该会话有效 |
| 项目默认 | 项目设置 → `profile.active` | **单值**，一个项目只能有一个 |

因此数字人那一轮是**数据模型改动**，不是 UI 改动，量级与本设计不同。

## 目标

1. 不切换激活项目，就能看到并修改一个面板应用在**所有**已跟踪项目里的启用状态。
2. 去掉全局开关，只保留项目维度，消除矛盾状态。
3. 面板应用进入设置页能力总览，让项目视角也能管面板应用。
4. 两个入口写**同一个** key，永不打架。

## 非目标

- 不支持把已打开的面板实例重新指向另一个项目。主进程会主动拒绝存活 guest 的项目
  不匹配（`panel-app-bridge.ts:405-411`），且 Electron partition 由
  `(hostId, projectPath)` 哈希得出（`panel-app-protocol.ts:66-93`）。「换项目」
  在架构上必然是销毁 + 重建，不是变更。
- 不在面板 dock 上加项目切换器。
- 不动数字人。

## 设计

### 第一段：扩展 → 面板应用（卡片内嵌项目清单）

`PanelsTab.tsx` 的每张卡片改为：

```
┌─ Design Studio  v0.1.0                          ┐
│  一个仓库原生的设计工作台                          │
│                                                  │
│  已在 3 / 5 个项目启用                    [展开 ▼] │
│                                                  │
│  [从源更新]  [卸载]                               │
└──────────────────────────────────────────────────┘
```

展开后：

```
│  已在 3 / 5 个项目启用                    [收起 ▲] │
│  ┌──────────────────────────────────────────────┐ │
│  │ codeshell  当前   ~/Documents/…/codeshell [●]│ │
│  │ my-app            ~/work/my-app           [●]│ │
│  │ blog              ~/blog                  [●]│ │
│  │ old-project       ~/archive/old           [○]│ │
│  │ scratch           ~/tmp/scratch           [○]│ │
│  └──────────────────────────────────────────────┘ │
```

规则：

- 每行一个项目 + 一个两态 `Switch`（来自 `@/components/ui`）。
- 项目排序复用 `sortProjects()`（`renderer/projects.ts`）：置顶在前，然后按 `addedAt` 升序。
- 当前激活项目那一行加「当前」标记，方便定位。
- 默认**收起**，只显示 `3 / 5` 计数——这个计数本身就是现在完全看不到的信息。
- 删掉顶部那条只读横幅「当前绑定项目：X」，其信息已被计数 + 「当前」标记取代。
- 安装完成后自动绑定到当前激活项目（保留现有行为，`PanelsTab.tsx:264`），
  并让该卡片自动展开一次，使用户看见绑到了哪。
- 没有任何已跟踪项目时，清单区显示「还没有项目，先在侧栏添加一个」。
- 安装入口（选择源文件夹 / zip / GitHub）仍要求存在激活项目
  （`activeProjectPath`），沿用现有的 `projectRequired` 提示。

**数据读取**：进入 panels tab 时并发 `1 + N` 次读：一次 `getSettings("user")`
（拿遗留 denylist），N 次 `getSettings("project", path)`（N = 已跟踪项目数）。
`Promise.all` 并发。

已验证 `getSettings` 接受任意路径，preload 与 main handler 均无 active-project
限制（`preload/index.ts:882-888`、`main/index.ts:4727-4730`）；
main 侧每次是一个小 JSON 的 `readFile`，缺文件返回 `null`。

**明确禁止**：不要为每个项目调 `listPanelAppExtensions(path, lang)`。该函数每次会
`discoverPanelApps` 并对每个已装 app 重新哈希（`panel-apps-service.ts:165-180`
→ `installedPanelAppRevision`，每 app 3×`statSync` + 2×`readFileSync`），
20 项目 × 10 app 会产生 1000+ 同步 fs 操作，卡住主进程。

**写入**：复用现有 `setProjectBinding` 逻辑，把硬编码的 `activeProjectPath` 换成
行上那个项目的 path。仍写 `panelAppBindings` 并把遗留的
`panelAppOverrides[appId]` 置 `null`。必须走 `renderer/settingsBus.ts` 的
`writeSettings`（而非裸 `window.codeshell.updateSettings`），以触发
`codeshell:settings-changed`。

**已知副作用**：`main/index.ts:4744-4750` 在 patch 含 `panelAppBindings` 时
`broadcastPanelAppsChanged`。逐项目切换会按次广播，属既有行为，不在本次优化。

### 第二段：去掉全局开关（纯 UI 移除）

采用**纯 UI 移除**：底层 key 保留可读，仅删除 UI 入口。

**删除**：

| 位置 | 内容 |
| --- | --- |
| `PanelsTab.tsx:38-45` | `nextDisabledPanelApps` 导出 |
| `PanelsTab.tsx:94-109` | `toggleGlobal` |
| `PanelsTab.tsx:583-592` | 全局 `Switch` + 标签 |
| `PanelsTab.tsx:565-569` | `disabledByPolicy` 分支（永为 false） |
| `PanelsTab.tsx:520-527` | 徽章三态收敛为 `projectBound ? boundAndEnabled : notBound` |
| i18n `extensions.ts` | `globallyDisabled`、`disabledByPolicy`、`globalToggle`、`globalToggleAria` |
| `shared/panel-apps.ts:75,80` | `globalEnabled`、`disabledByPolicy` 字段 |
| `main/panel-app-policy.ts:23,28,33` | `globallyDisabled` 计算，`enabled` 收敛为 `projectBound` |

i18n **必须 zh/en 成对删除**——`i18n/dict.test.ts:18-30` 断言双向 key 对等。

**保留**（这是「纯 UI 移除」的关键）：

- `settings/schema.ts:413` 的 zod key。移除会导致 Zod 从既有用户设置中剥离该字段。
- `panel-apps/bindings.ts:65,84-86` 的读取与 `isPanelAppBound` 里的
  `!globalDisabledApps.has(id)` 项。
- `main/index.ts:3189-3194` 卸载时的清理。

保留这三处的收益：老用户之前用开关关掉的 app 仍然生效、卸载时仍被回收，且
`bindings.test.ts`、`scanner.allowlist.test.ts`、`installer.test.ts`、
`schema.test.ts` 四个文件**零改动全绿**。手改
`~/.code-shell/settings.json` 成为应急后门。

**接受的代价**：UI 上不再有「一键全关」。一个 app 若绑在多个项目里又需要立刻停用，
只能逐项目取消勾选或卸载。这是有意的取舍——该开关本身就是矛盾状态的来源，
且卸载可兜底。

**busy key 的一处脆弱写法**（不是 bug，但改造时会变成 bug）：
`PanelsTab.tsx:575` 的项目绑定 Switch 判断 `busy === app.id`，而
`setProjectBinding` 写入的是 `` `panel-app:${appId}` ``（`:113`）。二者当前
**确实相等**，因为 descriptor 的 `id` 就是 `` `panel-app:${app.id}` ``
（`main/panel-apps-service.ts:65`），所以 disabled 态今天是生效的。

但第一段把单个开关拆成 N 行之后，busy 必须按「项目 × app」而非按 app 记，
否则勾一行会把同一张卡的所有行一起置灰。实现时改为显式的复合 key
（例如 `` `${appId}@${projectPath}` ``），不要继续依赖这个巧合相等。

### 第三段：设置 → 能力总览接入面板应用

在 `CapabilitiesOverviewSection` 项目 scope 下新增一个「面板应用」分组：

```
设置 →（项目 scope：my-app）→ 能力总览

  ▸ 内置工具        12 项
  ▸ 技能            8 项
  ▸ 插件            3 项
  ▸ MCP 服务        2 项
  ▸ 面板应用        2 / 3 项          ← 新增
    ├ Design Studio      [●]
    ├ Quant Lab          [●]
    └ Starter            [○]
```

**两态开关，不用三态「继承/开/关」。** 三态语义是「继承全局基线或在本项目覆盖」，
而面板应用没有全局基线可继承——它默认全关、由项目显式绑定。硬套三态会造出一个
含义为空的「继承」档。

先例：`ConversationSettingsSection.tsx:112-126` 使用同一套 `setCapabilityOverride`
IPC 但只渲染两态（只写 `on`/`inherit`，永不写 `off`），因为该场景同样是
默认全关 + 白名单。面板应用是同一形状。

**数据源：直读写 `panelAppBindings`**（已确认的决定）。该分组走专用读写路径，
绕开 `setCapabilityEnabled` / `setCapabilityOverride`。

代价是 `CapabilitiesOverviewSection` 中多一个特例分支。收益是单一数据源：扩展页与
设置页写同一个 key，永不打架。被否决的替代方案是新增
`capabilityOverrides.panelApps` bucket 并在运行时读两个 key——那会让两个 key 表达
同一状态，是 `panelAppOverrides` 遗留问题的翻版。

**实现约束（读代码后发现，必须在实现时决策）**：
`CapabilityKind = CapabilityDescriptor["kind"]`（`capabilitiesOverview.ts:14`）
是 **core 类型**，不是 renderer 本地联合类型。因此面板应用分组不能简单地加进
`CAPABILITY_GROUP_ORDER`。两条路：

- **(a) 渲染层并列**（推荐）：面板应用作为一个独立的组，在
  `CapabilitiesOverviewSection` 里与 `groupCapabilities()` 的结果并列渲染，
  不进 `CapabilityKind`。保持 core 不变，符合「面板应用不是 agent capability，
  而是 Desktop 应用状态」这一既有边界（`docs/panel-apps.md`）。
- **(b) 扩展 core 的 `CapabilityKind`**：加 `"panel-app"`。会牵动
  `capability-control` 的 service/overlay/types，且与上述边界冲突。

除非实现时发现 (a) 有阻碍，采用 (a)。

**仅项目 scope 显示**。user scope 下不显示该分组——面板应用没有全局启用概念，
显示一个全是「未启用」的列表只会误导。

**分组内数据**：项目 scope 下需要 `listPanelAppExtensions(projectPath, lang)`
拿 app 列表（此处只调一次，成本可接受）+ 该项目的 `panelAppBindings`。
沿用该组件既有的 `cacheKey` + `activeCacheKeyRef` + 单调序列号机制
（`CapabilitiesOverviewSection.tsx:132-203`），保证慢请求不会覆盖已切换的 scope。

**写入后**：调用该组件既有的 `load()` 重新拉取（与 `onProjectState` 一致，
不做乐观更新），并额外触发 `notifySettingsChanged()`——注意
`CapabilitiesOverviewSection` 当前**没有**调用它，而面板应用绑定的变更需要
main 侧广播以刷新 dock。

## 数据流

```
                    panelAppBindings: string[]   （项目设置，唯一数据源）
                              ▲          ▲
              ┌───────────────┘          └────────────────┐
              │                                           │
   扩展 → 面板应用                              设置 → 能力总览
   （app 视角：一个 app × N 个项目）        （项目视角：一个项目 × N 个 app）
   读 1 + N 次 getSettings                  读 1 次 listPanelAppExtensions
   写 writeSettings("project", path)         + 该项目 settings
                                             写 writeSettings("project", path)
              │                                           │
              └───────────────┬───────────────────────────┘
                              ▼
                     settings:set (main)
                              │
                  broadcastPanelAppsChanged
                              ▼
                  App.tsx refresh → replacePanelApps
                              ▼
                     dock 面板可用性更新
```

运行时判定语义不变（`bindings.ts:84-86`）：
`enabled = hasProject && boundApps.has(appId) && !globalDisabledApps.has(appId)`。
其中 `globalDisabledApps` 在移除 UI 后对新用户恒为空集。

## 错误处理

- 单项目 `getSettings` 失败：该行显示为未启用 + 一个可辨识的错误态，不让整张卡片失败。
  这一点很重要，因为 `panelAppPolicy` 的 fail-closed（`panel-apps-service.ts:144-151`）
  会让权限错误与「未启用」不可区分。清单 UI 直读 settings 可以区分二者，应当区分。
- 单行写入失败：回滚该行开关，在卡片级显示错误（沿用现有 `setError`）。
  不影响其它行。
- `TrackedProject.path` 指向已不存在的目录：`getSettings` 返回 `null`，读作「无绑定」。
  行仍然显示（用户需要看到并能取消勾选一个已消失的项目）。
- 已跟踪项目列表为空：清单区显示引导文案，不显示空表格。

## 测试

**新增单元测试**（纯函数，无 React/IPC）：

- 跨项目绑定计算：给定 `{projectPath → settings}` 映射与一个 appId，
  算出每个项目的启用态与 `已启用 / 总数` 计数。含遗留
  `panelAppOverrides` 的 `"on"` / `"off"` 迁移语义。
- 排序：置顶优先、然后 `addedAt`，与「当前项目」标记的确定性。

**修改的既有测试**：

- `PanelsTab.test.ts:8-16`：删除两个 `nextDisabledPanelApps` 测试
  （不删会因导出移除而导致整个文件 import 失败，连带第三个
  `nextPanelAppBindings` 测试一起挂）。保留第三个。
- `main/panel-app-policy.test.ts:18-62`：`policy()` 工厂中的
  `globalDisabledApps` 字段、以及断言 `globalEnabled` / `disabledByPolicy`
  的三处 `toMatchObject`。

**必须保持零改动全绿**（保留底层 key 的验证）：
`panel-apps/bindings.test.ts`、`skills/scanner.allowlist.test.ts`、
`panel-apps/installer.test.ts`、`settings/schema.test.ts`。
若这四个文件需要改动，说明「纯 UI 移除」的边界被破坏了，应回头检查。

**i18n**：`i18n/dict.test.ts` 的 zh/en 双向 key 对等。

**验证命令**（desktop 有独立的 typecheck/build，根目录检查覆盖不到）：

```bash
bun test
bun run typecheck                       # 根目录
cd packages/desktop && bun run typecheck && bun run build
bun run lint
```

## 文档更新

`docs/panel-apps.md` 的「Enablement」一节（约 118-128 行）需要更新，且它已经
**领先于本次改动就已过时**：

- 第 120 行称 `disabledPanelApps` 是 global app denylist —— 改为说明它仍被运行时
  读取，但已无 UI 入口，仅作手改后门。
- 第 121-122 行称 `panelAppOverrides` 「missing key inherits the global state」
  —— 这个继承语义在 `70d615f4` 之后就不存在了，现在是默认全关 + 项目显式绑定。
  应改为描述 `panelAppBindings` 为准、`panelAppOverrides` 仅作读时迁移。
- 第 127-128 行「Extensions → Panel Apps owns … global enablement」—— 移除
  global enablement，并补充设置 → 能力总览也是一个入口。

## 实现顺序

1. 抽出跨项目绑定计算的纯函数 + 单测。
2. `PanelsTab.tsx` 卡片内嵌项目清单（第一段），沿用现有两开关不动。
3. 移除全局开关（第二段），含类型、i18n、测试调整。
4. 能力总览接入面板应用分组（第三段）。
5. 更新 `docs/panel-apps.md`。

2 与 3 分开是有意的：先让新 UI 可用，再拆旧开关，任一步出问题都能单独回退。
