# Mimi 单入口 + 移动模式合并方案（2026-11-01）

> 状态：**已按本文在任务分支 `codex/desktop/mimi-unified-presence-20261101` 的 worktree 中实施（2026-11-01；实施会话因工具权限未能提交，未合并）**。用户已授权实施，T0 各项按 §9.1 的“实施采用”决定执行，不再作为开工前的确认门槛。实施记录、测试与未验收项见 [§9](#9-实施记录2026-11-01)。§2–§3 仍是基线代码的现状核对，行号以基线为准。
> 审查基线：`82c6f37ab6ef8dd29ee58aa7ca9a1daa0ea1d7c6`（`origin/main`，PR #266 合并提交，提交日期 2026-10-31）；审查日期 2026-11-01。
> 代码证据全部通过 `git show 82c6f37ab:<path>` / `git grep -n <pattern> 82c6f37ab -- <path>` 读取，行号以该基线为准。
> 关联：[全仓审查报告](repo-audit-20261101.md) · [Mimi CUA 角色原型说明](../mimi-cua-companion.md) · [数字人与 Pet 架构](../architecture/14-digital-human-and-pet.md) · [CUA 执行边界设计](../superpowers/specs/2026-10-28-mimi-cua-execution-boundary-design.md) · [舞台与应用档案设计](../superpowers/specs/2026-10-29-computer-use-stage-and-app-profiles-design.md) · [根 TODO](../../TODO.md)

## 0. 用户要求（作为验收约束）

用户原话：“mimi pet 和 移动的mimi怎么 是分开的 看看逻辑怎么合并在一起 不能同时出现 只是一个打开后有移动模式 默认有点太大了。”

落成可验收约束：

| 编号 | 约束 | 来源 |
| --- | --- | --- |
| U1 | 用户只看到**一个 Mimi 入口**（一个“显示 Mimi”开关），对应**一个一致的可见实例** | “合并在一起” |
| U2 | 打开 Mimi 后可切到**移动模式**；移动模式是同一个 Mimi 的模式，不是第二个功能开关 | “只是一个打开后有移动模式” |
| U3 | 停靠形态与移动形态**互斥**，任何时刻（含快速连点、并发入口、重启恢复、崩溃恢复）都不得同时可见 | “不能同时出现” |
| U4 | **默认尺寸缩小**，且仍可调 | “默认有点太大了” |
| U5 | 保留 `packages/pet` 能力边界：Pet 行为 / DelegateWork / 投影仍是能力包，不把 Pet 加回 core；窗口与呈现属于 Desktop 宿主 | CODESHELL.md Known Architecture Debt |

新尺寸已按 §9.1 **实施采用**（移动角色框默认 200 DIP）。

## 1. 名词：“移动的 Mimi”指什么

- **桌面“移动的 Mimi”** = Desktop 的 **Mimi CUA companion（操作角色）**：一个全屏透明、点击穿透的覆盖窗口，角色会走到电脑操作（CUA）的目标旁边、可拖动放置、右键恢复跟随。设置页文案为“显示 Mimi 操作角色（试验）”（`packages/desktop/src/renderer/i18n/ns/settings.ts:39`）。这是本方案的“移动模式”。
- **Mimi Pet 桌宠** = Desktop 的 **pet widget**：右下角 112×112 的悬浮小狗头，可展开为 400×380 的聊天/活动气泡。菜单文案为“显示 Mimi / 隐藏 Mimi”（`packages/desktop/src/renderer/i18n/ns/pet.ts:417-418`）。这是本方案的“停靠模式”。
- **手机 / 移动端 Mimi：现在没有 Mimi 形象界面。**
  - 手机入口 `packages/desktop/src/mobile/main.tsx:4,14` 挂载的是 `packages/web/app/DesktopApp`，`packages/web/app`、`packages/web/src` 里没有任何 mimi/pet/companion 引用。
  - Host 侧会主动过滤 Mimi：`packages/server/src/sessions-service.ts:98` 从会话列表剔除 `kind === "pet"`，`:352` 从磁盘会话列表剔除；`packages/desktop/src/main/mobile-remote/output-recovery-authority.ts:56,74,141` 拒绝 pet 会话的输出恢复；`legacy-transcript-history.ts:139` 同理。
  - 在手机上只能经 IM 通道（微信等，`packages/chat` → Desktop `pet-dispatch-service`）和 Mimi 对话，不涉及任何窗口或形象。
  - 结论：“移动模式”与手机端无关。本方案只改 Desktop 桌面形态，手机端行为不变。UI 文案要避免与“移动端”混淆，见 §5.6。

## 2. 现状：两个独立实现

### 2.1 两个表面对照

| 维度 | 停靠：pet widget | 移动：Mimi CUA companion |
| --- | --- | --- |
| 状态拥有者 | `packages/desktop/src/main/index.ts` 模块级变量 `petWidgetWindow` / `petWidgetWindowCreation` / `petWidgetShouldBeVisible` / `petWidgetSurfaceMode`（`:650-654`） | `createMimiCompanionHost` 闭包内的 `enabled/size/anchor/pinned/window`（`packages/desktop/src/main/computer-use/mimi-companion-host.ts:44-79`） |
| 何时创建 | 任何平台；只有用户打开时才创建（`index.ts:5913-5923`） | **仅 macOS**，且 CUA 执行闸门 `control` 创建成功后才有（`computer-use/desktop-setup.ts:65-110`）；`enabled` 为真时启动就建窗（`mimi-companion-host.ts:588`） |
| 窗口 | 112×112 DIP 无边框透明，`resizable:false`、`alwaysOnTop`，主 preload `preload/index.cjs`，default session（`index.ts:2954-2982`）；展开时 `setBounds` 到 400×380（`:3075-3085`） | 覆盖整块显示器 `display.bounds`；mac 用 `type:"panel"`、`focusable:false`、点击穿透；独立 preload `mimi-companion.cjs`、独立 partition `mimi-companion` 并带 CSP（`mimi-companion-host.ts:218-231, 258-289`） |
| 置顶 | mac `screen-saver` 级，其他平台 `floating`（`pet/pet-widget-window-state.ts:36-41`，`index.ts:2933-2943`）；全部工作区可见（`index.ts:2996`） | 复用同一个 `petWidgetAlwaysOnTopLevel`（`mimi-companion-host.ts:15,202-210`）；全部工作区、全屏可见（`:288`） |
| 显隐判定 | `petWidgetShouldBeVisible && window 存活`（`index.ts:5904, 5920-5922`） | `(enabled \|\| preview) && (!capturing \|\| humanActive) && !obstructed && !disposed`（`mimi-companion-host.ts:142-146`）；CUA 截图期间会自己隐藏（`:100-107`） |
| 持久化 | 只存位置：`codeShellHome()/desktop/pet-widget.json`（`pet-widget-window-state.ts:49-51,110-131`）；**显隐不持久化**，每次启动都是隐藏（`index.ts:652`，全仓只有 `:5914` 一处赋值） | `app.getPath("userData")/mimi-companion.json` 保存 `{enabled,size,anchor?}`（`mimi-companion-host.ts:45, 57-67, 180-190`）；`enabled` 会在重启后自动恢复显示 |
| 用户入口 | 账户/设置下拉菜单“显示/隐藏 Mimi”（`renderer/Sidebar.tsx:545-546` → `settings/SettingsMenu.tsx:258-260`）；Pet 设置页开关（`pet/PetSettingsPage.tsx:388-396`）；桌宠右键“打开 Mimi / 关闭宠物”（`index.ts:5931-5947`） | 设置 → 电脑操作页：“显示 Mimi 操作角色（试验）”开关、角色大小下拉、预览按钮（`settings/ComputerUseSettings.tsx:263-336`） |
| 聊天入口 | 桌宠内联聊天气泡，展开后 400×380（`pet/PetDesktopWindow.tsx:231-244`） | 点击角色打开**主窗口**的 Mimi 页面（`index.ts:3498` → `openPetOverviewFromWidget` `:3100-3110`；`App.tsx:968-979`） |
| IPC | `pet:widget-visible(-get)`、`pet:widget-visibility-changed`、`pet:widget-move/expanded/surface/context-menu/open-overview`（`index.ts:5903-5981`；preload `pet-api.ts:507-535`） | `mimiCompanion:*`（`mimi-companion-host.ts:375-578`）；设置走 `computerUse:setCompanion/previewCompanion`（`settings-ipc.ts:129-171`；preload `computer-use-api.ts:13-16`） |
| 测试 | `pet-widget-window-state.test.ts`、`PetDesktopWindow.test.ts`、`AppPet.test.tsx`、`preload/pet-contract.test.ts` | `companion-choreographer/-layout/stage-model/settings-ipc` 等单测；**`mimi-companion-host.ts` 本身没有单测**（`git grep -l mimi-companion-host 82c6f37ab -- "*.test.ts"` 无结果）；`test:e2e:companion-chat` 脚本（见 [原型说明](../mimi-cua-companion.md)） |

### 2.2 为什么现在是分开的

1. **来源不同。** pet widget 是 Pet 桌宠的概览/聊天/活动入口。companion 是 CUA 呈现实验：起点是 `7dca610dc feat(desktop): add opt-in interactive Mimi CUA companion trial`，后续经 PR #239、#244–#258 迭代。它挂在 computer-use 子系统下，由 `initializeDesktopComputerUse` 组装（`desktop-setup.ts:90-110`），依赖执行闸门的 `bus/gate`。
2. **文档明确列为后续工作。** 原型说明写着 “The existing compact pet widget is a separate surface in this experiment. Consolidating both surfaces and adding more natural action assets are follow-up product work.”（`docs/mimi-cua-companion.md:143-145`）。
3. **没有共同的状态拥有者。** 两者状态分处两个模块、写在两个根目录下的两个文件（`codeShellHome()` 和 `userData`），由两套 IPC 和两个设置页控制。
4. **互不感知。** `mimi-companion-host.ts` 从 pet 模块只导入了 `petWidgetAlwaysOnTopLevel`（`:15`）；`packages/desktop/src/main/pet/` 下没有任何 companion 引用；`index.ts` 的 widget 显隐逻辑也不看 companion 状态。

### 2.3 为什么能同时出现（确认）

在 macOS 上，用户在 Pet 设置或菜单里打开“显示 Mimi”（widget），又在电脑操作设置里打开“显示 Mimi 操作角色”（companion），两者会同时可见：

- 两条显隐判定（§2.1“显隐判定”一行）互相独立，没有任何互斥检查；
- 两个窗口都在 `screen-saver` 层、全部工作区可见，会互相重叠；
- 重启后 companion 按 `enabled` 自动恢复，widget 总是隐藏，形成“这次只有一个、下次又两个”的不一致；
- companion 的点击和 widget 的内联聊天是两个聊天入口，companion 的聊天 hold（`mimiCompanion:chatActive`，`mimi-companion-host.ts:418-430`）只接受主窗口发送方（`isMainWindow`），widget 的内联聊天不参与。

附带风险：**CUA 截图时只隐藏 companion，不隐藏 widget。**`hideForCapture` 只在 companion host 里实现（`mimi-companion-host.ts:100-107`；`git grep setContentProtection|hideForCapture 82c6f37ab -- packages/desktop/src/main` 只命中 companion 相关文件）。同屏时 widget 可能出现在模型截图里或遮住目标（静态风险，待真机验收）。

## 3. 实际默认尺寸（基线代码数值）

> 单位说明：Electron `BrowserWindow` 的尺寸和 `screen` 坐标是**逻辑像素 DIP**；渲染进程在缩放 1 时 CSS px = DIP；**物理像素 = DIP × 所在显示器 `scaleFactor`**（Retina 一般为 2）。基线 main/preload 中没有任何 `setZoomFactor/setZoomLevel` 调用，两个 Mimi 窗口都按缩放 1 渲染。设置页选项写的是“px”（`ComputerUseSettings.tsx:311-313`），实际含义是 DIP。

| 项 | 数值（DIP） | 证据 | Retina 2× 物理像素 |
| --- | --- | --- | --- |
| widget 收起窗口 | 112 × 112 | `pet-widget-window-state.ts:6`；`index.ts:2955-2956` | 224 × 224 |
| widget 狗头图像 | 96 × 96（`h-24 w-24`），容器 112（`h-28 w-28`） | `renderer/pet/PetWidget.tsx:113,199` | 192 × 192 |
| widget 展开窗口 | 400 × 380（268 气泡 + 112 锚点） | `pet-widget-window-state.ts:8-11` | 800 × 760 |
| widget 默认位置 | 工作区右下，距右/下边缘 24，最小边距 12 | `pet-widget-window-state.ts:7,89-99` | — |
| companion 窗口 | 整块显示器 `display.bounds`（透明、点击穿透，只有角色身体接收指针） | `mimi-companion-host.ts:258-259,285` | — |
| companion 角色框默认 | **高 320 × 宽 224**（宽 = 0.7 × size） | 默认值 `shared/mimi-companion.ts:92`；`renderer/pet/live2d/MimiCompanionWindow.tsx:335-336` | 448 × 640 |
| companion 可调范围 | 夹紧到 200–480；设置下拉只有 240/320/400/480 | `shared/mimi-companion.ts:110-113`；`ComputerUseSettings.tsx:311` | — |
| companion 工作时缩放 | 操作控件时 × 0.55（默认 320 → 176）；用户拖动固定后保持原尺寸 | `computer-use/stage-model.ts:39,135`；`mimi-companion-host.ts:151-153` | — |

按默认值比较：companion 角色框高 320，是 widget 狗头 96 的约 3.3 倍；面积 224×320 对 96×96，约 7.8 倍。用户说的“默认有点太大”与这组数字吻合。由于用户原话没有点明是哪一个，本文按**两种形态都给出建议**处理，以移动形态为主。

## 4. 目标模型

```
Mimi presence（唯一拥有者：Desktop main 进程 MimiPresenceController）
  visible: boolean                       ← 唯一“显示 Mimi”开关
  mode: "docked" | "moving"              ← 打开后可切换；互斥
  size: { preset, movingBoxHeight }      ← 统一尺寸配置
  docked: { anchor }                     ← 原 pet-widget.json
  moving: { anchor?, pinned }            ← 原 mimi-companion.json 的 anchor
        │ apply()（串行、代次校验、先隐藏后显示）
        ├── DockedSurface  = 现有 pet widget 窗口（抽出为模块，行为不变）
        └── MovingSurface  = 现有 companion host（去掉自己的 enabled 真相，只接受 presenting 指令）
```

- **内部可以保留两个窗口实现**（它们的窗口类型、preload、partition、点击穿透策略差别很大，强行合成一个窗口反而风险更高），但**用户永远只看到其中一个**。可见性只由控制器决定。
- 控制器放在 `packages/desktop/src/main/pet/`（宿主呈现层）。`packages/pet`（能力包）和 core 不做任何改动（U5）。
- `shared/mimi-companion.ts:1` 已规定 companion 只做呈现、不能发出电脑输入。合并后维持这一边界：模式切换不影响 CUA 执行闸门，也不得触发 CUA 安装、授权或输入。

## 5. 设计细节与边界

### 5.1 互斥与切换顺序

- `apply(next)`：生成递增 `generation`。**先隐藏当前形态，确认隐藏后再显示目标形态**（hide-before-show），允许出现 ≤300 ms 的“都不可见”空档，但绝不允许两者同时可见。
- 每个 `await`（建窗、`loadFile`、`ready`）返回后都要检查 `generation` 是否仍是最新；不是就放弃本次显示并隐藏刚建好的窗口。现有 `setPetWidgetVisibility` 已有显隐意图复核（`index.ts:5916-5918`），但尚无统一模式代次；新控制器需显式补齐。
- 不变量（写进单测）：每次显示/隐藏操作及每个异步恢复边界上均满足 `!(dockedVisible && movingVisible)`，且任意交错序列稳定后的可见形态等于最后一次请求。只检查序列结束状态不足以证明全程互斥。

### 5.2 快速连点与并发入口

- 所有入口（菜单、Pet 设置、桌宠右键、角色右键、电脑操作设置的兼容开关、预览、旧 IPC 别名）只提交 `setPresence(patch)`，控制器以“最新请求胜出”合并。
- **预览同样经过控制器。**删除独立建窗预览路径，或将预览作为同一个移动表面的临时状态：先隐藏当前表面；预览结束仅在请求代次仍有效时恢复之前模式，期间关闭 Mimi 必须取消预览，不能由过期定时器重新显示。不得在停靠模式旁额外显示预览角色。
- 渲染端乐观更新后，以 `mimi:presence-changed` 广播的**实际生效状态**为准，与现有 `pet:widget-visibility-changed` 回滚模式一致（`App.tsx:981-997`）。
- IPC 发送方校验：设置类请求只接受主窗口 main frame；两个 Mimi 表面自身只允许“切换模式 / 关闭 / 打开聊天”这类受限动作，并校验发送方是当前可见表面。

### 5.3 重启恢复与旧设置迁移

- 新状态文件：`codeShellHome()/desktop/mimi-presence.json`，带 `schemaVersion: 1`。和 `pet-widget.json` 同根，隔离测试已覆盖该根。写入沿用原子 tmp + rename；只有本进程写这个文件，如果将来出现跨进程写，需复用同一路径的跨进程锁协议。
- **一次性迁移**（读旧文件，不删除、不改写旧文件，便于回滚）：
  - 旧 `mimi-companion.json.enabled === true` → `visible: true, mode: "moving"`，`moving.anchor` 取旧 `anchor`；
  - 否则 → `visible: false, mode: "docked"`（旧 widget 显隐本来就不持久化，与现在“启动时隐藏”一致）；
  - `pet-widget.json` 的位置 → `docked.anchor`；
  - 尺寸：旧 `size === 320`（旧默认值，且旧文件无法区分“没改过”和“主动选 320”）→ 迁移到新默认值 200；其他合法值保留，并夹紧到新范围。**实施采用**（见 §9.1；旧文件保留，可回滚）。
  - 旧文件损坏 / 字段非法：按仓库“严格校验叠加旧数据”规则，隔离坏字段、其余用默认值，不抛错，也不覆盖原文件。
- 启动顺序：`moving` 依赖 `initializeDesktopComputerUse`（`index.ts:3496-3508`）创建的 companion host，所以控制器要在 `petIpcReady` 与 computer-use 初始化都完成后再 `apply`。在此之前**两个形态都不显示**，避免启动瞬间闪出两个。
- 持久化的 `mode=moving` 但当前不可用（非 macOS、`control` 创建失败、companion host 初始化失败）：**生效**模式降为 `docked`，**保存的偏好不改**；设置里显示“移动模式不可用：原因”。

### 5.4 关闭、退出与崩溃

- “关闭 Mimi”只置 `visible=false`，保留 `mode` 和尺寸。
- 应用退出：控制器先持久化，然后沿用现有 `closeComputerUse()`（`index.ts:7270`）和 widget 销毁路径。
- 表面崩溃：widget 的 `render-process-gone` 会直接销毁窗口（`index.ts:3015-3021`），companion 会写入 `error` 并销毁窗口（`mimi-companion-host.ts:297-300`）。控制器保持 `visible` 意图不变，进入“失败”子状态并在设置页显示错误和重试按钮。**建议**移动形态失败时提示一次并回落到停靠形态，以兑现“一个可见实例”；该回落策略待确认。

### 5.5 工作中 / 审批 / Cua 输入权限

- **执行闸门不随模式变化。**停止/继续电脑操作仍由执行侧负责（菜单、⌘⇧Esc `computer-use-control.ts:7`、设置页），见 [执行边界设计](../superpowers/specs/2026-10-28-mimi-cua-execution-boundary-design.md)。
- **停靠模式必须保留“停止电脑操作”入口。**现在 companion 自带 stop/resume（`mimi-companion-host.ts:528-539`），用户切到停靠后会失去这个入口。CUA 输入活跃时，在桌宠右键菜单补上“停止/继续电脑操作”，调用同一个 `gate.stopAll/resume`。
- **聊天 hold：**现在只有主窗口的 Mimi 页能触发 `holdForegroundForChat`（`mimi-companion-host.ts:418-430`，`isMainWindow`）。合并后停靠形态的内联聊天也是 Mimi 聊天面，建议聊天输入框聚焦时同样请求前台 hold，并放宽发送方校验到“当前可见的 Mimi 表面”。
- **截图隐藏：**控制器提供统一的 `hideForCapture`，隐藏**当前可见形态**（停靠也要隐藏），复用 companion 现有 ≤50 ms 合成器屏障（`mimi-companion-host.ts:100-107`）。这样同时修掉 §2.3 的附带风险。
- **审批 / 待办提醒：**停靠形态已有活动气泡和徽标；移动形态目前没有审批提示。Phase 1 先保证切到移动模式时有待批审批的话，在角色旁显示计数徽标，或者点击直达主窗口审批；不得因为切换模式让审批不可见。
- 工作中（CUA 运行）切换模式：choreographer 继续接收 bus 事件，只是不绘制；切回移动时从当前 activity 恢复，不重放历史动作。

### 5.6 多显示器 / DPI / 坐标换算

- 两个形态都用全局 DIP 坐标。切换时**保持“Mimi 站在同一个地方”**：
  - 停靠 → 移动：让角色实际脚底中点（`x + 0.35·height, y + height - companionFeetOffset(height)`；复用 `shared/mimi-companion.ts:103` 与 `stage-model.ts` 的脚底偏移）对齐 widget 狗头底边中点。当前 `mimi-companion-host.ts:501` 的 `0.9·size` 是投放检测的近似点，不能直接当视觉脚底；切换时使用当前生效高度（含工作缩放），不只读保存的基础尺寸；
  - 移动 → 停靠：把 widget 锚点放到角色脚底附近；
  - 两个方向都按目标形态各自的规则夹紧到所在显示器工作区（`clampPetWidgetWindowPosition` / `normalizeAnchor`）。
- 混合 DPI（例如 2560×1440 外接屏 + Retina 内屏）：只用 Electron DIP 计算，不自己乘 `scaleFactor`；`display-metrics-changed/display-removed` 时两个形态都要重新夹紧（companion 已有，`mimi-companion-host.ts:579-587`；widget 当前只在创建和移动时夹紧）。
- UI 文案：建议叫“**移动模式**（Mimi 在桌面上走动、跟随电脑操作）”，并加副标题，避免和“移动端 / 手机”混淆；停靠形态叫“**停靠模式**”。最终命名待用户确认。

### 5.7 尺寸（实施采用）

| 项 | 现值 | 建议 | 理由 |
| --- | --- | --- | --- |
| 移动形态默认角色框高 | 320（宽 224） | **200**（宽 140），约为现值的 62.5% | 等于现有下限；狗头 96 的约 2 倍，仍能看清动作 |
| 移动形态可调范围 | 200–480，下拉 240/320/400/480 | **160–480**，下拉 160/200/240/320/400/480 | 保留旧最大值，避免缩小已主动选大的用户 |
| 工作时缩放 | × 0.55（200 → 110） | × 0.55，**下限 96** | 小尺寸下工作姿态仍可辨认 |
| 停靠形态 | 窗口 112 / 狗头 96，不可调 | Phase 1 **不变**；Phase 2 可选统一“小/中/大”预设（窗口 96/112/136） | 用户没有明确说停靠太大；先缩移动形态，降低改动面 |

统一配置为 `size.movingBoxHeight`（数值）。设置页一个“Mimi 大小”控件同时作用于当前形态：Phase 1 只影响移动形态，Phase 2 才加停靠预设。

## 6. 最小架构改动与任务拆解

| 任务 | 内容 | 主要文件 | 体量 |
| --- | --- | --- | --- |
| T0 | ~~用户确认~~ 已由授权实施决定（§9.1）：默认尺寸、320 迁移规则、移动失败回落策略、模式命名、电脑操作页开关的去留 | 本文 | XS |
| T1 | 把 widget 窗口逻辑从 `index.ts:2882-3110, 5903-5981` 抽成 `DockedSurface` 模块，**零行为变化**，旧 IPC 保持 | `main/index.ts`、新 `main/pet/pet-widget-surface.ts`、`main/pet/pet-widget-window-state.ts` | M |
| T2 | companion host 拆开“偏好 enabled”与“是否呈现 presenting”：新增 `setPresenting(bool)` 和 `setSize(n)`；`update({enabled})` 保留为兼容路径，内部改为调用控制器 | `main/computer-use/mimi-companion-host.ts`、`desktop-setup.ts`、`settings-ipc.ts`、`shared/mimi-companion.ts` | S–M |
| T3 | `MimiPresenceController`：状态、串行 `apply`、代次校验、hide-before-show、持久化与迁移、可用性降级、统一 `hideForCapture` | 新 `main/pet/mimi-presence-controller.ts`、`mimi-presence-state.ts`；`main/index.ts` 接线 | M |
| T4 | IPC / preload：新 `mimi:presence-get/set`、`mimi:presence-changed`；`pet:widget-visible` 与 `computerUse:setCompanion` 作为兼容别名映射到控制器；更新类型与契约测试 | `preload/pet-api.ts`、`preload/computer-use-api.ts`、`preload/types.d.ts`、`preload/pet-contract.test.ts`、`tests/` 下 IPC 契约 | S |
| T5 | 渲染端入口统一：Pet 设置页一个“显示 Mimi”开关 + “停靠/移动”分段控件 + 大小；账户菜单只切显隐；电脑操作页把 companion 开关改为跳转到同一设置；两个表面右键各加“切换模式 / 关闭 Mimi” | `renderer/App.tsx`、`Sidebar.tsx`、`settings/SettingsMenu.tsx`、`pet/PetSettingsPage.tsx`、`settings/ComputerUseSettings.tsx`、`pet/PetDesktopWindow.tsx`、`pet/live2d/MimiCompanionWindow.tsx`、i18n `ns/pet.ts`、`ns/settings.ts` | M |
| T6 | 尺寸：新默认值与范围、工作缩放下限、设置选项 | `shared/mimi-companion.ts:92,110-113`、`computer-use/stage-model.ts:39,135`、`ComputerUseSettings.tsx:311` | S |
| T7 | 停靠模式补“停止/继续电脑操作”；停靠内联聊天参与前台 hold | `main/index.ts` 右键菜单、`mimi-companion-host.ts:418-430` | S |
| T8 | 测试与文档：控制器 / 迁移 / 互斥单测，`mimi-companion-host` 补单测，e2e `test:e2e:companion-chat` 增加互斥断言；更新 `docs/mimi-cua-companion.md:143-145` 与架构 14 章 | 测试文件、文档 | M |

合计 **M–L**，建议按 T1 → T2/T3 → T4 → T5/T6/T7 → T8 分 2–3 个 PR 落地。T1 是纯重构，可以先合。不碰 `packages/pet`、`packages/core`。

## 7. 验收矩阵

| # | 场景 | 期望 | 方式 |
| --- | --- | --- | --- |
| A1 | 设置里只有一个“显示 Mimi” | 账户菜单、Pet 设置、电脑操作页不再出现第二个独立显示开关；电脑操作页只链接到 Mimi 设置 | 渲染测试 + 人工 |
| A2 | 打开 Mimi（默认） | 显示停靠形态；移动形态不可见 | 单测 + 真机 |
| A3 | 切到移动模式 | 停靠隐藏后移动出现，全程不同时可见；角色位于切换前位置附近 | 单测（不变量）+ 真机录屏 |
| A4 | 快速连点：显隐 / 模式在 1 s 内各切 10 次，并且从两个入口同时触发；停靠时预览、预览中关闭、旧预览超时后切换 | 结束状态等于最后一次请求；任何采样点都不同时可见 | 单测（交错序列）+ 真机 |
| A5 | 重启恢复 | 恢复上次 `visible/mode/size/位置`；启动过程中不闪出第二个 | 隔离 HOME 的冷启动 e2e |
| A6 | 旧设置迁移 | `enabled:true` 的旧用户 → 移动模式可见；旧用户默认 320 → 新默认（若 T0 确认）；坏文件不抛错、不覆盖 | 迁移单测 |
| A7 | 非 macOS / CUA 闸门失败 | 移动选项禁用并说明原因；已保存的 `moving` 偏好降为停靠生效 | 单测 + Windows/Linux 冒烟 |
| A8 | CUA 运行中切换模式 | 执行闸门状态不变；截图时当前形态被隐藏；停靠模式右键可停止/继续 | 单测 + 真机（受控测试页，不碰用户浏览器） |
| A9 | 待批审批时处于移动模式 | 有可见计数或可直达审批，不因切模式丢失提醒 | 渲染测试 + 真机 |
| A10 | 多显示器 / 混合 DPI | 两形态在 2560×1440 + Retina 间拖动、拔插后都夹紧在可见工作区，切换位置正确 | 真机 |
| A11 | 默认尺寸 | 新安装移动形态角色框高 = 建议值（T0 确认后的值），设置可调到范围两端 | 单测 + 截图测量（DIP） |
| A12 | 全屏 Space | 移动形态在其他应用全屏时仍可见（沿用 10-28 已确认能力）；⌘⇧Esc 在全屏下可用仍是**未验收项** | 真机 |
| A13 | 关闭与退出 | “关闭 Mimi”后两形态都不可见且重启不恢复；退出无残留窗口或进程 | e2e |

源码单测与隔离 e2e 不能替代 A3/A4/A8/A10/A12 的真机验收；正式包验收仍归 [TODO](../../TODO.md) 的 P0.3。

## 8. 不做 / 后置

- 不把两个窗口合成一个 `BrowserWindow`（窗口类型、焦点、点击穿透、partition/CSP 差异大；只在用户可见层合并）。
- 不改 `packages/pet` 能力包与 core 协议；不为手机端新增 Mimi 形象。
- 不改变 CUA 执行权限、驱动版本或输入闸门语义。
- Live2D 适配仍是预留接口，不在本方案启用。

## 9. 实施记录（2026-11-01）

分支 `codex/desktop/mimi-unified-presence-20261101`，起点 `82c6f37ab` + 本文提交。只改 Desktop 宿主呈现层；`packages/pet`、`packages/core` 未改。

### 9.1 实施采用的决定（原 T0）

| 项 | 采用 |
| --- | --- |
| 入口 | 只有一个“显示 Mimi”开关（Mimi 设置页、账户菜单同一状态）；打开后切“停靠模式 / 移动模式” |
| 命名 | “停靠模式”“移动模式”，副标题注明移动模式是桌面角色、不是手机端 |
| 默认尺寸 | 移动角色框高 200 DIP（宽 0.7×）；范围 160–480；选项 160/200/240/320/400/480；工作态 ×0.55，下限 96；停靠狗头不变 |
| 320 迁移 | 旧 `mimi-companion.json.size === 320` 视为旧默认迁到 200；其他合法值保留并夹紧。旧文件无法区分“主动选 320”，因此主动选过 320 的用户会被降到 200，可在设置里重新选 320。新文件里的 320 视为主动选择，保留 |
| 首次迁移 | 新文件不存在时：旧 companion `enabled=true` → 移动可见；否则停靠且隐藏；`pet-widget.json` 位置 → 停靠锚点；companion 锚点 → 移动锚点。旧文件只读、不删不改，可回滚 |
| 坏文件 | 旧文件坏：逐字段保全合法值，不抛错，不改写原文件。新文件无法解析：先复制为 `mimi-presence.json.corrupt-<时间戳>`，再按旧文件/默认值启动 |
| 失败回落 | 移动表面加载失败或崩溃：先撤下移动表面，再回落停靠并显示错误；再选移动模式或点“重试”可恢复。保存的偏好保持移动 |
| 不可用 | 非 macOS、执行闸门或角色初始化失败：移动选项禁用并显示原因，生效模式为停靠，保存的移动偏好不改 |
| 电脑操作页 | 移除第二个独立开关、大小与预览；改为说明 + “打开 Mimi 设置”入口 |

### 9.2 落地结构

| 文件 | 内容 |
| --- | --- |
| `shared/mimi-presence.ts` | 快照/补丁类型（`visible/mode/size` + `effectiveMode/shown/movingAvailable/错误/previewing`） |
| `main/pet/mimi-presence-controller.ts` | 唯一拥有者：`set/preview/retry/start/surfaceFailed/setCaptureActive/rememberAnchor/dispose`；每次 apply 递增代次，先同步撤下非目标形态再显示目标，异步返回后校验代次，过期结果不显示且必要时再撤下；广播实际生效状态 |
| `main/pet/mimi-presence-state.ts` | 持久化（有序原子写入）、逐字段解析、旧文件迁移、脚底几何（停靠狗头底边中点；移动用实际绘制高度与 `companionFeetOffset`，不用 0.9×size） |
| `main/pet/pet-widget-surface.ts` | 停靠表面（原 `index.ts` 窗口生命周期抽出）：只在“被呈现 + 已加载 + 未被截图隐藏”时显示；撤下即销毁并作废进行中的创建；崩溃上报；显示器移除/度量变化时夹紧 |
| `main/pet/pet-widget-geometry.ts` | 纯几何常量与夹紧函数（从 `pet-widget-window-state.ts` 拆出并再导出） |
| `main/pet/mimi-presence-ipc.ts` | `mimi:presence-get/set/preview/retry`（设置类只收主窗口 main frame；停靠表面只读和关闭自己）；`pet:widget-visible(-get)` 与 `computerUse:setCompanion/previewCompanion` 兼容别名都落到同一拥有者 |
| `main/computer-use/mimi-companion-host.ts` | 去掉自有 `enabled` 与 `mimi-companion.json` 写入；改为 `present/withdraw/setSize/startPreview/cancelPreview/feet/placeFeet`；显示只在 `presenting` 时；撤下作废进行中的创建；截图时通知拥有者隐藏停靠；角色菜单加“切换到停靠模式 / 关闭 Mimi”；聊天 hold 接受停靠内联聊天 |
| `main/index.ts` | 启动加载/迁移后创建拥有者；computer-use 初始化完成且 pet IPC 就绪后才 `start`（启动期两形态都不显示）；停靠右键菜单含“切换到移动模式 / 停止或继续电脑操作 / 关闭 Mimi”；退出时先撤下并保存 |
| 渲染端 | Mimi 设置页唯一开关 + 停靠/移动 + 大小 + 预览 + 失败重试；账户菜单同一状态；电脑操作页改入口；停靠内联聊天参与前台 hold；中英文案 |

### 9.3 测试（新增/更新）

- 新增：`main/pet/mimi-presence-controller.test.ts`（启动前不显示、hide-before-show 事件顺序、过期加载与迟到 ready 不显示、40 组种子交错序列每步检查“不同时可见”且最终等于最后请求、关闭/预览结束竞态、预览加载中关闭、不可用与失败回落/重试、截图隐藏恢复只看最新状态、位置携带、尺寸夹紧、锚点持久化、dispose）；`mimi-presence-state.test.ts`（默认值、320→200、逐字段解析、迁移、旧文件字节不变、坏文件隔离、写入顺序与原子性、脚底几何）；`pet-widget-surface.test.ts`（并发共享一个窗口、加载中撤下、撤下后重建、崩溃上报、截图隐藏、显示器夹紧与监听清理、`placeFeet`、展开态锚点不变）；`mimi-presence-ipc.test.ts`（发送方校验、补丁校验、兼容别名映射）。
- 更新：`stage-model.test.ts`（工作态下限 96）、`settings-ipc.test.ts`（160–480 边界）、`pet-widget-window-state.test.ts`（源码契约指向新模块与“关闭 Mimi”）、`preload/pet-contract.test.ts`（presence 通道）、`ComputerUseSettings.interaction.fixture.tsx`（不再有第二开关/预览，改为入口）、`tests/architecture-budgets.test.ts`（新增 4 条 presence 路由计入总数，372→376）。
- **CC 初稿阶段运行情况（已由主控补验，当前结果见 §9.5）：当时未能运行任何测试、typecheck、lint 或 build**——`bun`（含 `bun --version`、`bun install --frozen-lockfile`）、`node scripts/run-bun-test-shard.mjs …`、`node …/typescript/bin/tsc` 均被工具权限拒绝（需人工批准，会话非交互）；`cp -R` 克隆依赖也被路径校验拒绝，未绕过。主控现已完成补验，结果见 §9.5；仍缺的原生/正式包项目见 §9.4。

### 9.4 仍待完成 / 未验收（2026-11-01 第二轮更新）

1. ~~**硬件缺口**：本机只有一块内置 Retina 屏（1512×982 DIP，scaleFactor 2），没有外接屏，因此多显示器、拔插、混合 DPI 下的夹紧与切换位置**未真机验证**。~~（2026-11-01 时的状态。）**2026-11-02 更新：**本机已接三块屏（内建 2×、VG2781-4K 2×、LS27B61x 1×），多显示器与混合 DPI 已实机验收并修复三处缺陷，见 §9.8。仍未做的只有**物理热拔插**（未拔线/关屏/改排列；移除与分辨率变化在测试进程内模拟）。
2. **原生 CUA 截图隐藏**未经真实 CUA 截图通道验证：需要真实 driver 截屏通道；生产代码没有、也不新增测试后门拿活动通道令牌。目前由实际 host 子进程测试（交互中截图隐藏）和控制器测试覆盖。
3. **⌘⇧Esc 在全屏 Space 下**未原生发送：本机正在运行的 CodeShell 宿主可能持有同一全局快捷键，发送它可能停止用户真实的电脑操作。
4. ~~移动模式下的审批计数徽标未做~~ 2026-11-02 已做（共享气泡层）：移动模式下停靠窗口的聊天框与工作列表改为“气泡窗口”（同一个 `PetDesktopWindow`，`role=bubble`，不画桌宠头像），随移动形态加载、隐藏待命；点击角色在她身旁弹出同一个输入框（再点收起，Esc/× 关闭，“完整页面”仍在气泡里）；气泡算出的运行中 / 待处理 / 未读完成数经 `pet:bubble-attention` 交给角色，头顶显示徽标，点徽标展开工作列表。气泡窗口开启内容保护，不进截图、也不因截图隐藏而丢输入焦点。实现：`main/pet/{pet-bubble-surface,mimi-bubble-host}.ts`；Electron 验收见 `e2e-mimi-companion-chat.mjs`。
5. PR/CI/合入与本机安装状态见 §9.6 与根 TODO；其他审查问题 R01–R04、R09–R28 仍保留，不在本实现中混修。正式包门禁仍归根 TODO P0.3。

### 9.5 主控补验与修正

CC 完成初稿后，主控在同一独立工作区补齐执行环境并完成下列验证。CC 初稿阶段的“命令需审批”是历史状态；主控正常使用宿主执行工具后已能安装依赖、运行检查与提交，没有提升为 bypassPermissions。

- 修复独立复核发现的三处 P2：移动表面捕获时无条件隐藏（包括悬停/拖动）；停靠并发呈现等待尚未完成的加载并共享失败；忙碌导致预览未启动时清理 previewing 并恢复用户模式。
- 抽取 `renderer/app/useMimiPresence.ts`，统一菜单/设置状态订阅，防止旧初读、旧请求回复覆盖更新的主进程广播或用户请求；`App.tsx` 保持在原架构预算内。
- 新增实际 `mimi-companion-host.test.ts` 与独立 Bun 子进程 fixture，只 fake Electron，实际执行 host、bus、choreographer：5 项覆盖迟到 ready/发送方、并发加载失败、关闭清理、交互中截图隐藏、忙时预览拒绝。另补控制器忙时预览恢复、停靠重复加载失败和 4 项 renderer hook 回归。
- CI 新增有界 presence 测试进程，避免扩大已接近上限的 Desktop shard；`lint:test-shards` 证实 2564 个测试文件均有归属，最大进程 770/772，未放宽分片预算。
- 最终只读复核确认上述修复与 hook 接线无关键阻断；这不构成逐行穷尽审计或原生视觉验收。

| 实际命令 / 范围 | 结果 |
| --- | --- |
| `bun install --frozen-lockfile` | 成功；锁文件未修改，依赖位于任务 worktree |
| `bun run build` | 全部基础包构建 exit 0 |
| guarded runner：`main/pet`、`main/computer-use`、`preload/pet-contract.test.ts`、`tests/architecture-budgets.test.ts` | 901 pass / 0 fail / 0 skip，85 files |
| guarded runner：控制器、停靠表面、presence hook、AppPet、PetDesktopWindow、`renderer/settings`、`preload`、architecture budgets | 403 pass / 1 skip / 0 fail，71 files；跳过项为未配置 Chromium 的 settings navigation 浏览器检查 |
| `bun run typecheck:workspaces`（基础包构建后） | 14 包 exit 0 |
| `bun run --cwd packages/desktop typecheck`（最终 hook / fixture 状态） | Desktop + mobile 配置 exit 0 |
| `bun run lint` | 0 errors / 98 warnings，与既有 warning 基线一致 |
| `bun run lint:test-shards` | 2564 个测试文件覆盖，最大进程 770/772 |
| `bun run --cwd packages/desktop build` | main / preload / renderer / mobile / Chrome extension 构建 exit 0；保留既有大 chunk 提示 |
| `node scripts/run-isolated-node-smoke.mjs --private-keyring packages/desktop/scripts/e2e-mimi-companion-chat.mjs --receipt packages/desktop/out/mimi-presence-acceptance-20261101.json` | 实际 Electron + 实际 worker + 本地 mock provider 通过；默认 200、模式切换、交错请求、预览中关闭，67 次窗口可见采样、0 次双显；同 Session 两轮聊天及前台 hold/释放通过；测试进程 cleaned、隔离 HOME 已删除、renderer errors 为空 |
| `git diff --check` / `git diff --cached --check` | 无空白错误 |

两组 Bun 范围存在重叠，不能把计数相加当作独立测试总数。Electron 回执保存在任务工作区的 `packages/desktop/out/mimi-presence-acceptance-20261101.json`；这是自动交互与 `BrowserWindow.isVisible()` 采样，不能证明全帧视觉互斥、原生输入命中、截图合成器、全屏或跨显示器行为。没有使用真实模型凭据、付费 API 或操作者当前的配置。

### 9.6 第二轮补验（2026-11-01，CC，在任务 worktree 执行）

新增两个只在本机运行的验收脚本（不进 CI）：`packages/desktop/scripts/e2e-mimi-presence-restart.mjs`（`test:e2e:mimi-presence-restart`）与 `e2e-mimi-presence-native.mjs`（`test:e2e:mimi-presence-native`，需要终端有辅助功能与屏幕录制权限），配套 `mimi-window-server-probe.swift`（`CGWindowListCopyWindowInfo` 只读窗口编号/层级/边界，不读标题与像素；另可发原生指针/按键）。两者都在 `scripts/run-isolated-node-smoke.mjs --private-keyring` 下跑：隔离 HOME/凭据、本地 mock provider，不调用模型。

| 验收 | 结果 | 证据边界 |
| --- | --- | --- |
| 冷重启 + 旧配置迁移（同一隔离 HOME 连续启动 3 次） | 通过。首启：旧 `mimi-companion.json {enabled:true,size:320,anchor}` + `pet-widget.json` → 移动可见、尺寸 200、移动位置=旧锚点、停靠位置=旧位置；两个旧文件逐字节不变。二启：恢复 visible/移动/240/拖动后的位置；切到停靠后窗口位于保存的停靠位置。三启：关闭状态保持隐藏，启动全程 0 次出现 Mimi 窗口 | 主进程每 5 ms 采样 `BrowserWindow.isVisible()`：三次启动共 2794 次采样、0 次双显；3 次进程均 cleaned、隔离 HOME 已删、renderer errors 为空 |
| 多个独立入口 | 通过：移动角色右键菜单“切换到停靠模式”（真实 DOM 点击）、账户菜单“隐藏/显示 Mimi”、电脑操作页无第二开关且“打开 Mimi 设置”跳转、Mimi 设置页停靠/移动按钮与尺寸下拉（240 后角色按 240 重绘）、设置页预览替换停靠、预览中关闭开关后越过 10 s 预览到期仍不显示、旧 `computerUse:setCompanion` 与 `pet:widget-visible`、多入口并发请求 | 同上（Playwright 驱动真实渲染端与 IPC） |
| 原生 / 合成器（本机） | 通过：在测试应用自有的**全屏 Space** 中，停靠与移动都由 WindowServer 列为 on-screen；对两种形态的窗口单独截图（`screencapture -l`）分别得到小狗头与位于 200 DIP 框内（0.7× 宽）的移动角色像素；**原生右键**停靠小狗头弹出原生菜单、原生按键选“切换到移动模式”；**原生右键**移动角色弹出其菜单、原生点击“切换到停靠模式”；交错切换期间 WindowServer 每 5 ms 采样 962 次：停靠 707 次、移动 242 次、同时 0 次 | 原生事件只在自有全屏 Space 内、且点位窗口栈中自有 Mimi 之上只有可穿透的透明覆盖层时才发送；只截取自有 Mimi 窗口、不截全屏；结束后恢复指针位置并退出全屏。回执（任务 worktree，`out/` 不入库）：`packages/desktop/out/mimi-presence-native-final.json` 与 `mimi-presence-native-final-captures/`；冷重启回执 `mimi-presence-restart-final.json` |
| 显示器 | 单块内置屏（scaleFactor 2）；多屏/混合 DPI 未覆盖（2026-11-01 历史状态） | 2026-11-02 三屏实机验收见 §9.8 |

注意：本机同时运行着已安装的旧版 CodeShell（`/Applications/code-shell.app`），它自己的移动 Mimi 覆盖层也在屏幕上；本轮所有判定都按测试应用 PID 过滤，并未触碰该应用。

### 9.7 合入、本机候选与安装（2026-11-01）

- **合入：**[PR #267](https://github.com/cjhyy/codeshell/pull/267) 以普通 merge commit `e69dff688` 合入 `main`（父提交 `82c6f37ab` 与任务头 `f0bdcc35c`）。必需检查为 `ci.yml` run 41281187947，事件 `pull_request`、headSha `f0bdcc35c`，14/14 通过；用 `--match-head-commit` 合入，未强推、未用 workflow_dispatch 代替。
- **本机候选：**在专用干净 worktree `.worktrees/mimi-local-candidate-20261101`（提交 `f0bdcc35c`，tree `5b8c5210e`，与合入提交 `e69dff688` 的 tree 相同）按发布流水线的 mac 步骤构建：`bun install --frozen-lockfile` → `build-workspace-dependencies.ts` → Desktop build → `predist.ts` → `CSC_IDENTITY_AUTO_DISCOVERY=false bunx electron-builder --dir --mac --arm64 --publish never`。版本 0.9.51（未改版本号、未打 tag、未发布），ad-hoc 签名，Identifier `com.cjhyy.codeshell`，与本机现装 0.9.51 的签名方式相同；`verify-computer-use-package.ts` 通过（driver 0.34.1、helper 1、arm64+x64），`codesign --verify --deep --strict` 通过，`app.asar` sha256 `3382e5a12e7f…ba4685`，主进程包含 `mimi:presence-get`、`mimi-presence.json`、`mimiCompanion:presence`。
- **打包候选验收：**新增 `e2e-mimi-presence-packaged.mjs`（`test:e2e:mimi-presence-packaged`，沿用打包检查夹具：首条指令 Main 守卫、私有 HOME、应用前后清单、只读默认钥匙串元数据）。对候选运行通过：新配置默认隐藏且移动尺寸 200、移动可用；停靠/移动切换及多入口并发时只有一个可见形态（168 次采样 0 次双显）；电脑操作页无第二开关，链接到 Mimi 设置，其开关能隐藏 Mimi；无原生密钥调用、无 renderer 错误、私有 HOME 已删、应用文件清单前后不变。
- **安装：**本会话运行在已安装的 `/Applications/code-shell.app` 之内（会话进程的父进程就是它），强行退出会中断当前 DriveAgent 作业，因此没有强杀或替换运行中的应用。改为登记一个用户级 LaunchAgent `com.cjhyy.codeshell.local-install.mimi-20261101`，等用户正常退出 CodeShell（应用包内所有进程都退出）后才动手：先校验候选 hash 与签名，把旧包改名为 `/Applications/code-shell.app.backup-<旧版本>-<时间戳>`（沿用本机已有的备份命名），用 `ditto` 安装候选，再次校验 hash 与签名，失败就恢复旧包；成功后写 `install-receipt.json`、重新打开 CodeShell 并移除自身。候选、脚本、`provenance.json`、日志都放在 `~/Library/Application Support/CodeShellLocalBuilds/mimi-unified-presence-20261101/`。不删除用户 dataRoot、设置、凭据或项目。**截至本记录，安装尚未发生**（等待用户退出；**2026-11-02 核对：已于 2026-11-01T07:55:37Z 安装**，`install-receipt.json` 的 target/rollback 存在，`/Applications/code-shell.app/Contents/Resources/app.asar` 实际 sha256 与回执及上面的候选值相同；该安装不含 §9.8 的修复）；安装后应核对 `install-receipt.json`、`/Applications/code-shell.app/Contents/Resources/app.asar` 的 sha256 与上面一致，并在应用里确认只出现一个 Mimi、默认较小、电脑操作页只有“打开 Mimi 设置”入口。
- **回滚：**退出 CodeShell 后把 `/Applications/code-shell.app` 删除或改名，再把 `code-shell.app.backup-0.9.51-<时间戳>` 改回 `code-shell.app`。取消尚未执行的安装：`launchctl bootout gui/$(id -u)/com.cjhyy.codeshell.local-install.mimi-20261101 && rm ~/Library/LaunchAgents/com.cjhyy.codeshell.local-install.mimi-20261101.plist`。

### 9.8 2026-11-02 三屏 / 混合 DPI 实机验收（CC，任务分支 `codex/desktop/mimi-multidisplay-acceptance-20261102`）

§9.4/§9.6 写于 2026-11-01，当时本机只接内置屏，所以多屏/混合 DPI 记为“无设备”。2026-11-02 本机已接三块屏，本节补做实机验收；旧记录保留为历史。

**真实拓扑**（Electron `screen.getAllDisplays()` 与 CoreGraphics `CGDisplayBounds`/显示模式逐项一致：Electron id = CGDirectDisplayID，`scaleFactor` = 像素宽 / 点宽；全局 DIP = macOS 点，主屏左上为原点）：

| id  | 屏                             | bounds（DIP）          | workArea               | scale | 物理像素  | 运行时的 Space                       |
| --- | ------------------------------ | ---------------------- | ---------------------- | ----- | --------- | ------------------------------------ |
| 1   | 内建视网膜显示器（主屏）       | (0, 0) 1512×982        | (0, 38) 1512×852       | 2     | 3024×1964 | 普通桌面                             |
| 2   | VG2781-4K（左侧）              | (-1920, 11) 1920×1080  | (-1920, 36) 1920×1055  | 2     | 3840×2160 | 另一应用的全屏 Space（该屏无菜单栏） |
| 3   | LS27B61x（右侧，顶边高于主屏） | (1512, -199) 2560×1440 | (1512, -174) 2560×1415 | 1     | 2560×1440 | 普通桌面（试跑期间曾是另一应用全屏） |

负坐标：屏 2 的 x、屏 3 的 y。混合 DPI：1↔3 直接相邻（2×↔1×），2↔3 需穿过屏 1。

**发现并修复的缺陷**（提交 `9cebe6b06`，只改 Desktop 宿主呈现层）：

1. **停靠形态在显示其他应用全屏 Space 的屏上消失。**停靠窗口是普通 NSWindow，macOS 不把它绘制在别的应用的全屏 Space 上：Electron 报 `isVisible()`，WindowServer 在屏列表里没有它（`kCGWindowIsOnscreen` 为空）。把停靠拖到这样的屏，或重启恢复到那里，Mimi 就看不见了。改为 macOS `type: "panel"`（与移动形态相同），并 `setVisibleOnAllWorkspaces(…, { skipTransformProcessType: true })`。只加 skip 不改 panel 不可靠（启动时创建的窗口仍不在屏），未采用。
2. **1× 屏上停靠小狗外有白色圆角方块**（屏幕上可见：只含自有背景的区域截图里出现白框）。二分定位为 `BrowserWindow.moveTop()` 作用在 112 DIP 透明小窗口上，会在 1× 屏留下不透明白色背板；与 panel 无关（修复前的 NSWindow 同样复现），200 DIP 以上的窗口不受影响。macOS 上停靠表面改为对**已可见**窗口 `showInactive()` 重新排到最前（实测同样排到同级遮挡窗之上），隐藏窗口不会因此显示；其他平台仍用 `moveTop()`。
3. **呈现移动形态时 CodeShell 的 Dock 图标消失。**移动表面的 `setVisibleOnAllWorkspaces` 未跳过进程类型转换，Electron 把应用转成 UIElement，直到停靠窗口重建时 `app.dock.show()` 才恢复。移动形态同样加 `skipTransformProcessType: true`；panel 不需要这次转换即可进入全屏 Space（实测）。

回归：`pet-widget-window-state.test.ts`（panel + skip 源码契约；旧源码不含两者）、`pet-widget-surface.test.ts`（macOS 不调用 `moveTop`、只重排可见窗口、截图隐藏中不会被显示；其他平台保留 `moveTop`）、`mimi-companion-host` 新场景 `keeps-dock-icon`。

**验收脚本**：新增 `packages/desktop/scripts/e2e-mimi-presence-multidisplay.mjs`（`test:e2e:mimi-presence-multidisplay`，只在本机运行），复用 confined fixture、electron-harness、watchdog、本地 mock provider，经 `run-isolated-node-smoke.mjs --private-keyring` 隔离 HOME/凭据，不调用模型。`mimi-window-server-probe.swift` 增加 `displays`、多屏 `sample`（按**所有**显示器的全局 bounds 分类，接受菜单栏下移；另计“未分类大覆盖窗”）、`drag`、自有前台助手 `front`、`frontmost`、`type`。分类与期望几何放在 `mimi-multidisplay-geometry.mjs`，由 `mimi-multidisplay-geometry.test.mjs` 与生产函数逐值对齐（含负原点、同尺寸屏、菜单栏下移）。原 native 脚本的 `ownedMimi` 改用同一分类：旧实现只比较主屏宽高，会漏掉其他屏上的移动窗口（普通 Space 中移动面板被放在菜单栏下，也不等于屏幕 bounds）。BrowserWindow 与 WindowServer 窗口按 `getMediaSourceId()` 的 CGWindowID 一一对应，全程按测试 PID 过滤。

**最终结果**（提交 `9cebe6b06`、工作树干净，2026-11-02T03:44:57Z–03:47:02Z，passed）：

| 场景                                                                                     | 结果                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 每屏停靠 / 移动                                                                          | 停靠窗三屏都是 112×112 DIP；截图 224×224 px（2×）/ 112×112 px（1×）；不透明像素 68×75.5 / 68×76 DIP（最大差 0.5）。移动窗 = 该屏宽高（普通 Space 中 y 在菜单栏下 +38/+25/+25），截图 3024×1964 / 3840×2160 / 2560×1440 px = 点数 × 该屏倍率；角色像素 124×144.5 / 124×146 DIP（最大差 1.5），默认 200 DIP。BrowserWindow bounds = WindowServer bounds，渲染端 windowOrigin = 实际窗口原点                                                        |
| 停靠↔移动位置                                                                            | 三屏切换锚点误差 0 DIP，脚底公式残差 0.35 DIP（取整）；像素测得两形态脚底相差 6.08 DIP（狗图底边与角色鞋底的绘制差，三屏相同）                                                                                                                                                                                                                                                                                                                   |
| 边缘 / 角落                                                                              | 每屏 4 角 × 停靠先 / 移动先 = 24 组，全部 0 DIP 误差、都留在原屏 workArea；其中 12 组移动形态按目标 workArea 夹紧（如狗头贴顶时 200 DIP 角色放不下）                                                                                                                                                                                                                                                                                             |
| 快速切换 / 预览 / 关闭                                                                   | 每屏 6 轮交错（含旧别名与并发）+ 预览中关闭；WindowServer 每 5 ms 全屏采样 870 / 881 / 874 次（共 2625）：0 次双显、0 次出现在其他屏、0 个未分类覆盖窗；CUA 输入闸门（enabled / active / stopped / foregroundHeld）前后一致                                                                                                                                                                                                                      |
| 原生跨屏拖动（三块屏都进入自有全屏 Space）                                               | 10 次 CGEvent 拖动：移动与停靠各 1→2、2→1（2×↔2×，跨负 x）、1→3、3→1（2×↔1×）、2→3（穿过两条边界）。落点与指针位移误差全部 0 DIP；尺寸不变；每次约 450 次 WindowServer 采样（共 4502）：0 次双显、0 次在屏外，源屏和目标屏都有采样（连续跨屏）；闸门不变。落到 1× 屏的 3 次停靠做了合成区域截图（区域内只有自有背景 + Mimi）：窗口边缘就是背景色，无白框。落到屏 1 的 2 次因安装版 CodeShell 的全 Space 覆盖层在该区域内而按隐私规则跳过区域截图 |
| 停靠聊天焦点（改 panel 后）                                                              | 自有前台助手进程激活时，原生点击小狗：展开为 400×380，输入框获焦、宠物窗是 key window；原生键入 `mimi 3 screens` 完整到达输入框（只在前台应用与 key window 都属于测试进程时才发键）；聊天期间前台 hold = true，关闭后 10.16 s 释放。点击会激活测试应用本身（与修复前一致）                                                                                                                                                                       |
| 显示器移除 / 度量变化（在测试进程内替换 Electron `screen` 返回值并发事件；真实屏未断开） | 移除屏 2：移动 (-768, 458) → (0, 458)，停靠 → (12, 458)，都到屏 1；移除屏 3：移动 (3048, 392) → (1372, 392)，停靠 → (1388, 392)；移除后切换形态仍在屏 1、误差 0。屏 3 workArea 缩到 60%：停靠 (3922, 1091) → (2924, 521)，移动锚点在新 workArea 内。真实窗口按 WindowServer 在真实屏上移动                                                                                                                                                       |
| 冷重启（同一隔离 HOME）                                                                  | 第 2 次启动：停靠恢复在屏 3 右上角 (3872, -144)（负 y）；启动期 1207 次采样里停靠只在屏 3、移动 0 次。第 3 次启动：移动恢复在屏 2 (-1620, 256) 且 pinned；1182 次采样只在屏 2、停靠 0 次；恢复后切换误差 0                                                                                                                                                                                                                                       |
| Dock 图标                                                                                | 31 个快照全部可见（修复前移动形态期间为隐藏）                                                                                                                                                                                                                                                                                                                                                                                                    |
| 进程 / HOME                                                                              | 3 次启动都 cleaned；BrowserWindow 每 5 ms 采样 15877 / 779 / 826 次，0 次双显；renderer errors 为空；隔离 HOME 已删除                                                                                                                                                                                                                                                                                                                            |

同一提交上的回归：原 native 脚本通过（自有全屏 Space 内原生右键/按键/点击互切，975 次全屏 WindowServer 采样：停靠 582、移动 246、同时 0）；冷重启脚本第一次在第 2 次启动前被测试夹具的钥匙串安全预检拒绝（`CODESHELL_KEYCHAIN_PREFLIGHT_IDENTITY_CHANGED`，Electron 未启动，第 1 次启动的 7 项检查已通过），重跑通过，两份回执都保留；`e2e-mimi-companion-chat` 通过（真实 worker + 本地 mock 模型）。guarded Bun：`main/pet`、`main/computer-use`、`preload/pet-contract`、`tests/architecture-budgets`、几何测试 914 pass / 0 fail（86 文件）；Desktop typecheck、改动文件 ESLint 0 错误、`lint:test-shards`（2565 文件，最大进程 770）、Prettier、`git diff --check` 通过。

**观察（未改）：**普通 Space 中 macOS 把整屏移动面板放在该屏菜单栏下方，窗口下缘超出屏幕 25–38 DIP（透明、点击穿透）；渲染用实际窗口原点，角色位置不受影响。把角色拖放到另一个应用的窗口上会弹出“让 Mimi 看看「…」？”（既有功能，不点击不发送，8 s 撤回）；同时运行开发版与安装版时，安装版的全 Space 透明覆盖层也会被当作“下面的窗口”。

**仍未做（精确边界）：**

- **物理热拔插**：没有拔线、关屏、改排列或分辨率，也没装虚拟显示器；`display-removed` / `display-metrics-changed` 只在测试进程内模拟。
- CUA 真实截图通道隐藏、全屏下 ⌘⇧Esc（§9.4 第 2、3 项）不在本轮。
- `/Applications/code-shell.app`（0.9.51，asar `3382e5a1…ba4685`）不含本节三处修复；本轮未重装、未重启宿主。合入后要靠新的本机安装或正式发版生效，正式包验收仍归根 TODO P0.3。

证据（本地，不入库，只含自有窗口）：`~/Library/Application Support/CodeShellLocalBuilds/mimi-multidisplay-20261102/`（`README.md` 索引；三屏回执 `mimi-presence-multidisplay-final.json` 与 21 张截图；native / restart / chat 回执；`before-fix/` 修复前证据）。
