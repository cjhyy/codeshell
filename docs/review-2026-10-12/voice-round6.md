# 第六轮：语音输入与录音失败恢复

审查快照：`/Users/admin/.codex/worktrees/review-latest-20261012/codeshell`，提交 `a66f4ef291f304ee4df9da8095a90671d9a8f140`。产品只读；未重新构建或改动 dist。已读 CODESHELL.md 和主报告，排除 R04/R05/R34/R40/R41 的既有根因。

本轮收束 **1 项新发现的 P2（W17）**。`git diff 84740d56..a66f4ef2 -- packages/desktop/src/renderer/ChatView.tsx` 为空，缺陷在旧基线已存在，本轮新发现，不是 0.9.33 引入。另核对 Desktop 权限拒绝/重新录制、Web Panel 请求权限/取消/保存失败恢复的正常路径。没有访问实际麦克风、模型 API 或第三方账号。

## W17 / P2：录音启动等待期间可再次点击，停止和组件卸载只回收最后一份录音

**生产入口。** Desktop 主聊天 `packages/desktop/src/renderer/App.tsx:2442` 渲染真实 `ChatView`。其麦克风按钮 `packages/desktop/src/renderer/ChatView.tsx:2103-2109` 只在转写、压缩或 STT 不可用时禁用；用户已配置 STT、聊天可编辑时，等待麦克风权限或设备初始化不禁用按钮。独立测试挂载同一个真实 ChatView（quickChat 变体，共享此录音实现），未以重写录音算法作为证据。

**精确根因。** `packages/desktop/src/renderer/ChatView.tsx:597-612` 的 `startRecording` 先 await `ensureMicAccess`、`getUserMedia`，没有同步的 starting/requesting 状态或 in-flight 互斥。`voiceState` 直到 `mr.start()` 后的 `:632` 才变为 recording。第二次点击仍经 `:666-670` 的 idle 分支进入另一次启动。两个异步请求均成功时，`:612`、`:630` 的单一 stream/recorder ref 被后者覆盖，`:634` 也清除第一份最大时长定时器。停止 `:657-664` 仅处理当前 ref；组件卸载 `:519-535` 同样仅处理当前 ref，因此已失去引用的首份 recorder/track 没有主动停止路径。

**真实操作时序。**

1. STT 可用，用户点击麦克风；系统权限提示或设备初始化尚未返回。
2. 按钮仍启用，用户再次点击（例如认为首击没有响应）。
3. 两次 `getUserMedia` 均成功，分别启动 recorder A 和 B。
4. 用户点击红色停止键，仅 B 停止，界面可回到 idle。
5. 用户切换到凭据/自动化等视图，React 卸载聊天组件（App 条件渲染见 `:2417-2442`）；A 仍未被 `stop()`，其 track 也未被 `stop()`。

**影响。** 同一个 renderer document 内，UI 显示已经停止、聊天组件已卸载，首份麦克风录音仍没有被主动回收，并失去 120 秒保护定时器。它还与后一份录音共用 `audioChunksRef`。此结论限定在两次启动请求成功的流程；不声称拒绝权限时会采集，也不声称关闭整个 Electron 窗口或 document unload 后仍会采集。验证使用假的 MediaRecorder/MediaStream，未进行真实硬件复现。

**独立复现与对照。** `voice-lifecycle.test.tsx` 首个测试通过真实 React 组件的按钮 callback 发起两个点击，两个可控 getUserMedia promise 在两次点击后先后成功；之后再次点击停止并卸载。输出：

```text
VOICE_DOUBLE_START_LEAK {"startedRecorders":2,"stoppedRecorders":1,"firstTrackStopCalls":0,"firstStillRecordingAfterUnmount":true}
```

正常单次录音卸载对照：仅创建 1 个 recorder，卸载时 recorder.stopCalls=1、track.stopCalls=1、不会启动转写。正常权限拒绝对照：不请求流、不创建 recorder，原草稿不变；授权后重试可以录音并将转写结果追加到原草稿。等待 getUserMedia 时卸载对照：晚到的 stream 被停止，不创建 recorder。

**建议。** 在第一个 await 前同步占用启动互斥状态，明确展示正在请求权限，并确保取消/卸载会使此启动 generation 失效；每次已获流和 recorder 应保留独立所有权并保证 finally 回收。新增“同一组件、两个 pending 启动”回归，不能只覆盖单次录音和 late result after unmount。

信心：高（生产入口 + 真实组件稳定表征 + 单击/拒绝/晚到释放对照；真实硬件未测）。独立质量代理已确认不与 R04/R05 重复，详见主代理汇总的质量审查。

## 正常路径与未升级项

- Web Panel capture 在 `packages/web/app/panel-audio-capture.ts:81-99` 先发布 requesting 并阻止第二次 start；abort 后晚到流会停止。本轮可控 fixture 验证通过，没有对应 W17 的重复启动缺陷。
- Web Panel 权限拒绝给出可重试 error；随后成功录音保留 blob 供 review；abort 清除 blob、停止轨道。`PanelAudioDialog.tsx:29-50` 在组件卸载时 abort/close 并撤销本机 blob URL。
- 挂载真实 Web `PanelAudioDialog` 验证保存：模拟分块已提交但响应丢失，界面仍显示试听/下载和错误提示；再次保存走同一个 upload 的 get/finish，不重复上传字节，成功后撤销 URL。相应实现 `PanelAudioDialog.tsx:66-86` 和 `panel-resource-upload.ts:132-191`。
- 真实 Web 对话框在 upload.write pending 时取消：finish 仅返回 cancelled，组件卸载使传入上传信号 aborted；迟到响应不触发 finish、不发下一次调用；blob URL 被撤销。Host 本身只允许一个录音请求，`PanelHost.tsx:647-648`；取消使 `:651-665` 删除对话框，request.call 在 `:687-705` 固定授权与 signal。
- Desktop 转写返回失败后，已键入草稿保留且可重新录制；本轮验证下一次点击开启新录音而不会重试上一次音频。录音停止时 `ChatView.tsx:624-627` 已清空共享 chunks，失败后 `:581-591` 仅 toast 并回 idle，没有录音备份/原音频重试入口。这是现有恢复限制，暂未作为第二个正式缺陷上报，避免将期望新增 UX 直接当成错误。
- Desktop 录音/转写跨会话的迟到草稿身份仍依赖 App 的当前 bucket setter，属于已记录 R04/R05 同类会话归属问题，本轮不重复计数；没有宣称切换会话会自动卸载 ChatView。
- Web/mobile 聊天 Workbench 未找到独立语音听写按钮，本轮 Web 录音覆盖实际 PanelHost 的 `resources.recordAudio` 入口，而非假设不存在的聊天语音入口。上传断线问题 R34 保留在既有报告，不重复。

## 可复验记录

```sh
cd /Users/admin/.codex/worktrees/review-latest-20261012/codeshell
node scripts/run-bun-test-shard.mjs --timeout 30000 /tmp/codeshell-review-20261012-voice-round6/voice-lifecycle.test.tsx
```

脚本依赖符号链接：此目录 `node_modules` 指向审查快照根 node_modules。源码 import 使用新快照绝对路径；迁移位置需相应替换，不能暗中换基线。

最终日志 `voice-lifecycle.log`：**1 文件、9 测试、87 断言、0 失败、0 跳过，643 ms**。通过表示已观察到缺陷和上述正常行为，不表示已修复。guarded runner 提供隔离 HOME 和应用状态；脚本在任何 ChatView/Core-facing 动态 import 前安装全局 fetch 拒绝 guard。这是 fetch guard，未宣称完整 http/net 级网络封闭；实际 STT IPC、流、录音及转写回执全部由本地 fixture 提供，没有导入或调用实际 STT provider。测试 afterEach 在完成缺陷断言后专门清理未被产品回收的假 recorder。未触碰用户服务/真实硬件/付费 API。产品工作区状态与开始一致，仅 root 拷入的未跟踪 review docs。

主审已将脚本改为仓库相对导入并保存在 `reproductions/voice-round6/`，分别在初始与0.9.33工作区 guarded 重跑，均9测试/87断言通过；无需原始/tmp的node_modules链接。
