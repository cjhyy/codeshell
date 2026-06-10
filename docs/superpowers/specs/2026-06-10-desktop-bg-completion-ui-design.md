# desktop 后台完成提示(视频等)UI 设计

- 日期: 2026-06-10
- 状态: 已确认,定稿待实现
- 目标项目: codeshell `packages/desktop` (renderer)

## 背景与问题

core 在后台任务(视频生成等)完成时,会 enqueue 一条通知并经 `agentNotificationBus` → server → `background_agent_completed` StreamEvent 推到 renderer。但 **renderer 的 `applyStreamEvent`(types.ts)没有处理这个事件**(落到 `default: ignore`),所以 desktop 用户在 app 内**完全看不到完成提示**:
- 消息流无提示
- 无 toast
- main 进程那条系统通知只在 app **失焦**时弹,且标题写死"自动化任务"(对视频不准)
- 只能自己去 `.code-shell/generated_videos/` 翻

视频生成 sessionId 链路完整(已确认),通知确实发到了 renderer,差的就是 renderer 这一环呈现。

## 目标

desktop 收到 `background_agent_completed` 时:**消息流插一条系统消息 + 弹一个 toast**。

## 事件结构(已确认)

`BackgroundAgentCompletedEvent`(core types.ts):
```
{ type: "background_agent_completed"; agentId; name?; description; status: "completed"|"failed"; finalText?; error?; enqueuedAt }
```
视频完成时:`name="video generation"`,`description="Video generated: <path>..."`,`finalText="Video saved to <path>"`,`status="completed"`。失败:`status="failed"`,`error`。

## 架构(两个独立改动点)

### 1. 消息流插系统消息 —— 在 reducer `applyStreamEvent`(types.ts)
加 `case "background_agent_completed"`:push 一条现成的 `kind:"system"` 消息(SystemMessage{kind,id,text},MessageStream 已能渲染:居中小灰字)。文案:
- completed:`✓ ${name ?? "后台任务"}完成:${finalText ?? description}`
- failed:`✗ ${name ?? "后台任务"}失败:${error ?? description}`
用 `freshId("bg-done")` 生成 id。纯 reducer,可单测。

### 2. toast —— 在 App.tsx 的 `onStreamEvent` 回调(组件体内,有 hook 访问)
`applyStreamEvent` 是纯函数不能调 hook;但事件进入处 `window.codeshell.onStreamEvent(env => ...)`(App.tsx ~1048)在组件体内,能用 `useToast()`。在该回调里,当 `event.type === "background_agent_completed"` 时:
```
toast({ message: <同上文案>, variant: status==="completed" ? "success" : "error" });
```
App 已被 main.tsx 的 ToastProvider 包裹,`useToast()` 可用(App.tsx 顶部加 import + `const toast = useToast()`)。

**为何分两处**:消息流(持久可查)走 reducer,是状态;toast(即时提醒)是副作用,走事件回调——副作用不该塞进纯 reducer。两处用同一套文案(抽一个小 helper `bgCompletionText(event)` 放 types.ts 导出,两边复用,避免漂移)。

## 触碰文件
1. `packages/desktop/src/renderer/types.ts` — 加 `bgCompletionText()` helper(导出)+ `applyStreamEvent` 的 `background_agent_completed` case
2. `packages/desktop/src/renderer/App.tsx` — import useToast + `const toast = useToast()` + onStreamEvent 回调里对该事件调 toast
3. `packages/desktop/src/renderer/types.test.ts` — reducer case 单测

## 非目标
- 不改 main 进程那条失焦系统通知(可后续单独优化文案;本期 renderer 内提示已覆盖有焦点场景)
- 不在消息流里做花哨的视频卡片/缩略图(用现成 system 消息即可;后续可升级)
- 不碰 core(通知链路已完整)

## 测试 / 验证
- types.test.ts:喂一个 background_agent_completed(completed/failed)→ 断言 messages 末尾多一条 kind:"system" 且文案含路径/错误。
- desktop tsc --noEmit + build:renderer 绿。
- (人工)desktop 跑一条视频,完成时:消息流出现"✓ video generation 完成:Video saved to ..."+ 弹 success toast。

## 与既有衔接
- 复用现成 SystemMessage 渲染(MessageStream.tsx case "system")+ 现成 ToastProvider/useToast。
- 不影响其它 StreamEvent 处理(只加一个 case,default 不变)。
- 后台 Agent / shell 完成走同一事件,本改动让它们在 desktop 也有提示了(顺带受益)。
