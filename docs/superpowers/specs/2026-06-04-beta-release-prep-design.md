# 测试版准备 — 设计文档

- 日期: 2026-06-04
- 状态: 已确认,待实施
- 受众: 少数熟人/同事内测

## 目标

让少数熟人拿到 **Electron 桌面 App 安装包** 和 **npm 测试版包**,装上能跑、
核心功能不崩、开箱即有默认 agents + 可浏览的市场源。发布前在本机把整条
链路冒烟一遍。

因受众是少数熟人,质量门槛偏低:
- mac **不强求签名/公证**,右键打开可接受。
- 崩溃靠口头反馈,不接崩溃上报。
- 重点是「能装上、能跑起来、核心功能不崩」。

## 当前真实就绪状态(2026-06-04 实测)

| 项 | 状态 | 说明 |
| --- | --- | --- |
| `bun run build`(core+tui+meta) | ✅ 通过 | npm 包侧能出 dist |
| `bun run typecheck`(root) | ⚠️ 7 错 | **全在 `*.test.ts`**,不进 dist,但测试套件已腐化 |
| desktop 打包(`electron-builder`) | ❓ 从没跑过 | `dist/` 空,产物名/图标/能否启动全未验证 |
| App hover 显示 "Electron" | ⚪ dev 态固有 | `productName` 已=code-shell;`app.setName` 已在 `index.ts:121`;打包后即修复;非 bug |
| 默认 agents | ❌ 无 seed | 4 个 .md 在 `examples/agents/`(git 跟踪)与本仓 `.code-shell/agents/`(未跟踪);无内置/首启 seed |
| 默认市场源 | ❌ 无 seed | 市场 UI 全有,但必须用户手动 `marketplace add`;开箱为空 |
| 图像生成 | ✅ 已是内置工具 | `GenerateImage`(`generate-image.ts`),非技能;有可用性门控 `isGenerateImageAvailable`(依赖 API key/baseURL) |
| 模型可调的「装市场」能力 | ❌ 无 | `addMarketplace()`(`marketplaceManager.ts:87`)现仅 desktop UI 能调 |
| agent 联网能力 | ✅ 已有 | `web-search` / `web-fetch` 内置工具 |

## 工作块(按依赖排序)

### 块 0 — 修测试套件腐化(前置)

`typecheck` 的 7 个错全部在测试文件里,是 API 漂移导致,不进 dist。但
「内部冒烟跑完整一遍」要求测试绿。

涉及文件:
- `packages/core/src/automation/write-policy.test.ts:59` — `undefined` 不能赋给 `CronPermissionLevel`
- `packages/core/src/llm/providers/openai-reasoning-effort-drop.test.ts:14` — `OpenAI.APIError` 当类型用,应 `typeof OpenAI.APIError`
- `packages/core/src/tool-system/builtin/update-automation-memory.test.ts:26,27,36,44` — 把 `BuiltinToolResult` 当字符串用(`.startsWith` / `.toLowerCase`),应读其 `result` 字段
- `packages/core/src/tool-system/executor-abort.test.ts:23` — 传入对象缺 `RegisteredTool` 的 `source` / `permissionDefault`

**产出**: `bun run typecheck` 0 错,`bun test` 绿。

### 块 1 — Electron 真打包 + 验证名称/图标

`dist/` 从没出过包。跑 `electron-builder`(mac arm64+x64 dmg/zip),验证:

- 产物 hover/Dock 名 = code-shell(`productName` 已正确,本步证伪 "Electron"
  问题——那是 dev 态 `electron .` 跑 `Electron.app` bundle 固有现象,打包后
  `Info.plist` 的 `CFBundleName` 会是 code-shell)
- 图标正确(`build/icon.icns` 已存在)
- 双击能打开
- 首屏能起
- 能跑一轮对话

**产出**: 本机能装能跑的 dmg。

### 块 2 — 开箱默认 seed(首次启动初始化)

三件事:

1. **seed 4 个默认 agents** — 源用 `examples/agents/`(git 已跟踪:
   explorer / general-purpose / planner / researcher)→ 首启 seed 到
   `~/.code-shell/agents/`。
2. **seed 几个市场连接** — 预填 `known_marketplaces.json`,用户打开市场即有
   源可浏览;**不预装任何插件**,装哪个由用户自己配。
3. **验证 `GenerateImage` 工具** — 图像生成已是内置工具,**不新建 image
   SKILL.md**(技能是「教模型怎么做」的另一层,本轮不做)。只需确认熟人配好
   API key/baseURL 后,门控 `isGenerateImageAvailable` 放行、工具默认可用。

机制(采 TODO-week #5 调研的 A 方案):electron-builder `extraResources`
携带种子目录 + desktop main 首启检测(已 seed 过则跳过)。用户可改可删。

**产出**: 全新机器装上打开,子代理列表非空、市场有源可逛、配好 key 后能生图。

### 块 3 — 新工具:AddMarketplace(让 agent 能装市场)

新增一个内置工具,包 core 现成的 `addMarketplace(name, source)`
(`packages/core/src/plugins/marketplaceManager.ts:87`,已从 `index.ts`
export)。

- **只做一件事**:加一个 marketplace 源。装哪个插件由用户在 UI 配。
- 带**权限门控**:该工具联网 + git clone + 写盘,属有副作用工具,走权限闸。
- 配合现有 `web-search` / `web-fetch`,agent 能完成「搜到源 → 加进去」。
- 按 **TDD** 做(本块是唯一的创造性新功能)。

**产出**: 模型可调的 AddMarketplace 工具,有权限闸,有测试。

### 块 4 — npm 测试版发布物

- 版本从 `0.5.0-rc.0` 推进 → `0.5.0-rc.1`。
- `bun run build` 已通过。
- 校验 `package.json` 的 `files` 字段、`npm pack` 内容、干净环境
  `npx @cjhyy/code-shell@rc` 能起。
- 以 `--tag rc` 发布(**不污染 `latest`**)。

**产出**: 可 `npm i @cjhyy/code-shell@rc` 试用。

### 块 5 — 内部冒烟 checklist + 分发说明

一页纸:

- **冒烟流程**:全新环境装 dmg → 打开 → 跑一轮对话 → 切模型 → 用一个默认
  agent → 关掉重开(session 恢复)。npm 侧同理(`npx` 起 → 对话 → 退出重进)。
- **分发说明**:给熟人的简短文档——怎么装、mac 右键打开绕过 Gatekeeper、
  怎么反馈问题。

**产出**: 冒烟清单 + 分发文案。

## 执行顺序

```
块 0(前置)
  → 块 1、块 2、块 3 可并行
    → 块 4
      → 块 5
```

块 3(新工具)是唯一有创造性新功能的块,按 TDD 做。

## 不做(本轮明确排除)

- mac 签名 / 公证(熟人内测,右键打开可接受)
- 崩溃上报 / 隐私声明(对外公开下载才需要)
- 预装推荐插件(只 seed 市场源,不装插件)
- 新建 image SKILL.md(图像生成已是内置工具)
- AddMarketplace 之外的插件生命周期工具(卸载/启禁——本轮不做)

## 相关记忆 / 资料

- TODO-week #5「内置默认 agents/skills 随发布」调研料(A/B 方案)
- 插件市场设计:`docs/superpowers/specs/2026-05-19-plugin-marketplace-design.md`
- `app.setName` 已在 `packages/desktop/src/main/index.ts:121`
