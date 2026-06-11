# 对话(no-repo)设置页 — 默认全关 skill/plugin + 白名单

> 状态:**设计已批准**,待转实现计划。
> 日期:2026-06-11 ｜ 作者:与用户 brainstorming 定稿

## 0. 一句话

把"不绑代码目录的纯聊天(no-repo chat)"当成一个固定的"默认项目",新增一个独立的「对话」设置页。该作用域下 **skill 和 plugin 默认全关**,用户手动白名单勾选要用的;builtin 工具保持默认开,但"没有 cwd 就没意义"的那批置灰禁用。核心动机:用户想要"随便聊点无关内容"时不被 superpowers 那套 SessionStart 注入打扰,且不影响真实代码项目、也不用全局关。

## 1. 背景与现状(已查证)

- **no-repo chat 已有固定 cwd**:`resolveNoRepoCwd()` = `join(homedir(), ".code-shell", "no-repo")`(`packages/desktop/src/main/agent-bridge.ts:37-41`)。无项目聊天 spawn 时用它当 worker cwd(`agent-bridge.ts:108`)。
- **core 对任何非空 cwd 都读项目级配置**:`readDisabledLists`(`packages/core/src/engine/engine.ts:2836-2860`)用 `effectiveDisabledList(全局 disabledX, 项目 capabilityOverrides.X)` 折叠,**denylist 模型**(默认开,列出来的关,三态 on/off/inherit)。
- **plugin hook 受 disabledPlugins 压制**:`loadPluginHooks`(`packages/core/src/plugins/loadPluginHooks.ts:152-159`)拿 `readDisabledLists().disabledPlugins`(已折叠项目覆盖),禁用的 plugin 不注册任何 hook,**包括 SessionStart 注入**。所以把 plugin `superpowers` 设为禁用,即可压住那段"你有超能力"。
- **superpowers 是 plugin(非 skill)**:走 SessionStart hook 注入 `using-superpowers` ruleset。它的 skill 工具(`superpowers:using-superpowers`)是另一回事。要让对话清净,必须从 **plugin** 维度关它,只关 skill 压不住注入。
- **能力列表 API 已就绪**:`CapabilityService.list(cwd)` 返回 `CapabilityDescriptor[]`(`packages/core/src/capability-control/types.ts:14-40`),含 `id`(如 `"skill:x"` / `"plugin:y"` / `"builtin:bash"`)、`kind`、`name`、`enabled`、`globalEnabled`、`projectOverride`。前端经 `window.codeshell.listCapabilities(cwd)` / `setCapabilityOverride(cwd, id, state)` 调用(`packages/desktop/src/main/capabilities-service.ts`)。
- **配置只有全局/项目两级**,session 本身不带配置(`SessionState` 无配置字段,`packages/core/src/types.ts`)。因此"对话级配置"= 复用 no-repo cwd 的项目级配置,不新增"session 配置层"。

### 已决策(brainstorming)
- ✅ chat = 一个固定的"默认项目",作用域 = `~/.code-shell/no-repo`,写项目级 `capabilityOverrides`。
- ✅ 独立「对话」设置页(不挂 ProjectPicker)。
- ✅ 交互:**默认全关,手动一个个打开**(白名单 / opt-in)。
- ✅ skill **和** plugin 都默认全关 + 白名单。
- ✅ builtin 保持默认开;cwd 依赖的置灰不让开(产品意义上"无项目目录不可用",非技术上跑不了)。
- ✅ agent / mcp 这一期不放(YAGNI)。
- ✅ "默认全关"只绑 no-repo,不做成通用"精简作用域";真实项目继续 denylist(默认开)。
- ✅ 实现:`readDisabledLists` 加 no-repo 分支反转为白名单。

## 2. 作用域与正确性约束

- **目标 cwd**:`~/.code-shell/no-repo`。
- **配置落点**:`~/.code-shell/no-repo/.code-shell/settings.json` → `capabilityOverrides.skills` / `.plugins`。
- **关键约束**:UI 写设置用的 cwd 字符串必须 **完全等于** 运行时 Engine 的 `config.cwd`,否则写到 A 读到 B 就对不上。两者源头都是 `homedir()/.code-shell/no-repo`,但渲染进程是 thin client(不 import core、拿不到 `homedir()`)。
- **解法**:main 进程暴露一个 IPC(如 `noRepoCwd()`),内部调用同一个 `resolveNoRepoCwd()`,UI 用它拿到权威路径。**绝不让 UI 自己拼路径**(避免平台/符号链接差异)。把 `resolveNoRepoCwd` 抽到一个 main 可复用的位置,IPC 与 spawn 共用同一实现。

## 3. core 改动(唯一一处)

修改 `packages/core/src/engine/engine.ts` 的 `readDisabledLists`:

- 判断 `cwd === <no-repo cwd>`(core 需要一个判定:要么从 config 传入一个标志,要么 core 也能解析 no-repo 路径)。
  - **倾向**:在 core 暴露/复用一个 `noRepoCwd()`(`homedir()/.code-shell/no-repo`),`readDisabledLists` 内比对。core 已有 `userHome()`,加一个 `noRepoDir()` 同源。避免把判定职责散到 desktop。
- 命中 no-repo 分支时,**skill 与 plugin 反转为白名单**:
  - 列出所有已安装 skill 名 / plugin 名(scanSkills / readInstalledPlugins 的名字集合)。
  - 凡未在 `capabilityOverrides.skills` / `.plugins` 中显式标记 `"on"` 的,全部加入 `disabledSkills` / `disabledPlugins`。
  - 显式 `"on"` 的放行。
- **不反转** agent / mcp / builtin —— 它们仍走原 denylist。
- **真实项目零回归**:分支仅在 `cwd === no-repo` 命中;其余 cwd 逻辑逐字不变。
- **新装 skill/plugin 自动是关的**(无显式 on)——符合"默认全关"。
- 由于 `loadPluginHooks` 吃的是 `readDisabledLists().disabledPlugins`,plugin 反转后 **superpowers 的 SessionStart 注入自动被压制**。

### 单元边界与测试
- 把"白名单反转"做成纯函数(输入:所有已安装名字 + overrides bucket;输出:有效 disabled 列表),可独立单测,不依赖 Engine。
- 测试覆盖:(a) no-repo 默认全关(无 override → 所有 skill/plugin 进 disabled);(b) 白名单(某 skill on → 仅它放行);(c) 真实项目 cwd 不受影响(仍 denylist);(d) 新装 skill 默认关;(e) plugin 反转 → superpowers 进 disabledPlugins → loadPluginHooks 不注册其 hook(复用现有 loadPluginHooks 测试模式)。

## 4. desktop 新增「对话」设置页

- **导航**:`SettingsPage.tsx` 的 `MODULE_GROUPS`「环境与连接」组加一项 `{ id: "conversation", label: "对话", Icon: ... }`,渲染分支加 `active === "conversation"`。
- **页面组件**(新文件,如 `ConversationSettingsSection.tsx`):
  - 启动时经新 IPC 拿 no-repo cwd,`listCapabilities(noRepoCwd)` 取能力列表。
  - **顶部**:说明文案("以下设置只影响无项目的纯聊天对话")+ 「全部关闭」按钮(把所有 skill/plugin override 清回默认全关 = 删除所有 `on`,回到 inherit/全关态)。
  - **skill 列表**:每行一个开关。有效态默认关;开 = `setCapabilityOverride(noRepoCwd, "skill:x", "on")`;关 = 设回 `"inherit"`(等效全关)。
  - **plugin 列表**:同 skill。superpowers 出现在这里,默认关。
  - **builtin 区**:列出 builtin。不依赖 cwd 的显示为默认开(可不提供开关或显示只读"默认开");**依赖 cwd 的置灰禁用**,点不动,标注"对话无项目目录,不可用"。cwd 依赖清单:`read` / `write` / `edit` / `glob` / `grep` / `apply-patch` / `enter-worktree` / `exit-worktree` / `lsp` / `notebook-edit`。
  - agent / mcp:本期不渲染。
- **UI 规范**(desktop CLAUDE.md):shadcn/ui + Tailwind;开关用 `@/components/ui/switch`;按钮 `Button`;不手写原生控件;写盘走 `writeSettings`/`setCapabilityOverride` 并触发 `notifySettingsChanged()`。
- **热生效**:同其他设置——新对话读到新配置;running session 取决于热重载链(`settingsBus → configure`)。UI 文案需对用户讲清"对新对话生效"。

## 5. 非目标(本期不做)

- ❌ 通用"精简作用域 / 默认全关"开关给任意项目(只绑 no-repo)。
- ❌ session 级配置层(复用 no-repo cwd 的项目级即可)。
- ❌ 对话页里配 agent / mcp。
- ❌ 改 builtin 的全局默认(只在对话页 UI 层置灰,不改 core 的 builtin 默认)。
- ❌ ProjectPicker 加"对话"条目(改为独立页,此路放弃)。

## 6. 风险 / 待定

- ⚠️ **core 判定 no-repo**:core 自己解析 `homedir()/.code-shell/no-repo` vs 由 desktop 经 config 传标志。倾向 core 内聚一个 `noRepoDir()`(与 userHome 同源),避免判定逻辑散落。实现计划阶段定。
- ⚠️ **白名单需要"所有已安装名字"全集**:skill 用 scanSkills 名集、plugin 用 readInstalledPlugins 名集。要确认这两个全集在 readDisabledLists 上下文里可低成本拿到(scanSkills 已在 prompt composer 路径用过)。
- ⚠️ **「全部关闭」语义**:是删掉所有 `on`(回默认全关),不是把每个显式写 `off`。确认 setCapabilityOverride 的 "inherit" = 删除 key。
- ⚠️ **builtin 置灰只是 UI**:core 不改 builtin 默认,所以技术上 no-repo 里 Bash/文件工具仍可跑(在 no-repo 目录内)。置灰是产品引导,不是硬阻断。需向用户明确这层区别(或后续若要硬禁,再走 capabilityOverrides.builtin off,本期不做)。
- ⚠️ **热生效粒度**:running 对话可能要新开才生效,UI 文案说明。
