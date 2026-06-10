# 视频生成配置 UI(泛型复用图片面板)设计

- 日期: 2026-06-10
- 状态: 已确认,定稿待实现
- 目标项目: codeshell `packages/desktop`(renderer)

## 背景与目标

core 已有 `videoGen.providers[]` schema + GenerateVideo 工具 + FalVideoProvider(已真机验证),但 desktop 设置页的「视频生成」分组仍是空壳占位符(`VideoGenConnectionsPanel` 只显示一段"暂未接入"文案)。

目标:把空壳换成真正的配置面板,与「图片生成」面板一致(配 key/baseUrl/默认模型/设默认/清除);通过把图片面板抽成泛型组件来复用,避免代码重复。

## 关键约束
- **纯 renderer 改动,不碰后端/IPC。** 视频不做「测试」按钮(视频 probe 需新后端 IPC,每次 ~80s/~$0.56,体验与成本都不合适;连通性已由真机验证,要测让 Agent 跑一条 GenerateVideo)。
- renderer 不 import core,只通过 `window.codeshell.*`。
- desktop 有独立 `tsc --noEmit` + `build:renderer`,根目录检查不覆盖——实现后必须在 packages/desktop 跑这两个。
- 动了图片面板 → 必须验证图片面板行为不回归。
- UI 沿用现有面板的 class(`conn-card` 等)+ `@/components/ui/button`;新部分优先 shadcn,但不顺手做大迁移。

## 架构

新建泛型组件 `GenConnectionsPanel.tsx`,从 `ImageGenConnectionsPanel` 提取。所有 image/video 差异由一个 `config` 对象注入:

```
interface GenPanelConfig {
  settingsKey: "imageGen" | "videoGen";   // 读写 settings.<key>
  providers: ProviderMeta[];                // 预置 provider 卡片
  showTest: boolean;                        // 是否渲染「测试」按钮+测试相关 UI
  testFn?: (input) => Promise<ProbeResult>; // showTest 时用(image: probeImage)
  labels: { testIdle, testBusy, sectionHint, ... };  // 文案差异
}
```

- `ImageGenConnectionsPanel` → 瘦成:用 image config(openai/google、showTest:true、probeImage)调 `GenConnectionsPanel`。
- `VideoGenConnectionsPanel` → 用 video config(fal + 即梦占位、showTest:false)调 `GenConnectionsPanel`。

### ProviderMeta 扩展
加两个可选字段以支持占位:
```
disabled?: boolean;        // 占位卡:渲染灰态,禁用所有输入+按钮
comingSoonNote?: string;   // 占位卡的预告文案
```
image 侧不设 disabled(都可用),不受影响。

### video 的两张卡
| provider | id/kind | 状态 | baseUrl 默认 | model 默认 |
|---|---|---|---|---|
| fal | fal | 可配 | https://queue.fal.run | fal-ai/kling-video/v3/pro/text-to-video |
| 即梦(火山) | jimeng | disabled 占位 | — | — |

即梦占位卡:渲染但禁用,显示 comingSoonNote("即将支持,后端适配器未接入"),**不写入 settings**(disabled 不可填,且无 key 本就跳过 writeBack)。

## 数据流(沿用图片面板,泛型化 key)
- 读:`window.codeshell.getSettings(scope, cwd)` → `settings[config.settingsKey].providers[]` → 按 meta.id 匹配填入卡片状态。
- 写:`writeSettings(scope, { [config.settingsKey]: { defaultProvider, providers } }, cwd)`。只持久化有 apiKey 的卡(现有逻辑),disabled 卡天然被跳过。
- 默认 provider:`defaultProvider` 字符串,setDefault 写回。

## 测试按钮的泛型处理
- `showTest: true`(image):渲染「测试生图」按钮 + 状态 pill(测试中/可用/失败)+ 预览图区,调 `config.testFn`。
- `showTest: false`(video):不渲染测试按钮、不渲染测试 pill/预览;状态 pill 只显示 已配置/未配置。

## 设置页挂载(不变)
video 面板仍作为「连接」tab 下 `SearchConnectionsPanel.tsx` 的 CollapsibleGroup 子分组(行 48-54 已有),只是把里面渲染的组件从空壳换成真面板。不新增一级菜单。

## 触碰文件
1. `packages/desktop/src/renderer/settings/GenConnectionsPanel.tsx` — 新建(泛型组件 + 卡片)
2. `packages/desktop/src/renderer/settings/ImageGenConnectionsPanel.tsx` — 改为薄封装(image config → GenConnectionsPanel)
3. `packages/desktop/src/renderer/settings/VideoGenConnectionsPanel.tsx` — 改为薄封装(video config,fal+即梦占位)
4. (可能)样式:占位卡灰态用 Tailwind `opacity`/`pointer-events-none` + 现有 class,不新增 styles/ 文件

## 错误处理
- 沿用图片面板:save/clear/test 的 try-catch + console.error + 失败回滚。
- video 无 testFn,跳过测试相关错误路径。

## 测试 / 验证
renderer 多为交互组件,无既有单测框架强约束;验证以构建+人工回归为主:
1. `packages/desktop` 跑 `bunx tsc --noEmit` —— 无类型错误。
2. `packages/desktop` 跑 `bun run build:renderer` —— 构建成功。
3. 回归断言(代码层自检):image config 仍预置 openai/google、showTest:true、settingsKey:"imageGen";video config 预置 fal(可配)+jimeng(disabled)、showTest:false、settingsKey:"videoGen"。
4. 若有轻量组件测试设施则加一条:GenConnectionsPanel 渲染 disabled 卡时输入框 disabled。

## 非目标
- 视频「测试」按钮 / video probe 后端 IPC。
- 即梦后端适配器(占位卡仅 UI 预告)。
- shadcn 全面迁移(沿用现有 class)。
- 新增设置页一级菜单。
