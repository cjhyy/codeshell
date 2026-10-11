# 第六轮 Collection 候选独立质量复核

复核基线：`a66f4ef291f304ee4df9da8095a90671d9a8f140`；工作区 `/Users/admin/.codex/worktrees/review-latest-20261012/codeshell`。已读该工作区 `CODESHELL.md`。只读生产代码、与 `84740d56` 的差异、交付说明、既有测试及本轮 `recovery.test.ts` / 日志 / observations；本审计没有重跑测试、启动模型或修改产品。

## 结论

**建议新增一项 R49，P3，标题收窄为“共享资料集跨文件查询吞掉已知原件变更的恢复指引”。** 本轮报告的事实和因果成立，分级适当。通用错误可以继续作为未知失败、授权拒绝或缺失可信 receipt 的安全兜底；它并不意味着必须吞掉 Core 已知、单文件入口已公开的安全版本变更诊断。

不建议以“全部子错误应当保留”“拒绝读取导致查询失败”或“资料集无法恢复”入表，也不应升为数据丢失、安全漏洞或 P2。用户可以逐文件试读，或在 Desktop 资料集设置中查看状态并显式更新；被修改的原件和资料集记录均未丢失。

## 因果、可达性与新旧边界

1. **正常生产入口存在。** 新 `ReadSource` schema 支持资料集 `resources: [{scope, resource}]`；`sources.ts:595–611` 允许 `access.kind === "collection"` 调用 corpus。Desktop 的 `renderer/credentials/SourceCollectionsSection.tsx` 具有真实原件选择和逐条 refresh 操作，项目 binding 是既有 Main 服务入口。本轮 fixture 只代替 native picker / reference callbacks，真实 capture、binding、adapter、版本检查与 refresh 均走生产代码。无需非法配置、Hooks 或故意绕过权限。
2. **真正错误来源明确。** 正常修改所选本地原件后，`collection-local.ts:153–169` 比较 dev/ino/大小/mtime/SHA-256，抛出 `Collection file changed since selection; update the collection before reading`。单文件 `ReadSource` 的 `sources.ts:685–686` 原样给出这个恢复方向。
3. **父层确实覆盖原因。** `sources.ts:453–473` 得到真实子调用结果后，把 `result.isError` 和 `!receipt` 合并为同一 generic 错误；没有带出已选择的 scope/resource 或版本变化原因。`recovery-observations.json` 同时记录变更原件和末文件审批拒绝得到相同父错误，而单文件读取保留更新提示。不是测试自行制造了 generic 错误。
4. **可以恢复，影响在诊断与恢复成本。** observations 的真实 Desktop service 更新对照为 `changed → ready`、entry ID 保持、hash 更新、同一 corpus 参数恢复两个匹配。`ListSources` 的 Collection 分支 `sources.ts:140–152` 是纯 metadata 投影，仅给出资源名/ID/记录大小，不检查当前原件状态，不能凭一次普通列举补回失败原因；Desktop service 的 `localStatus` / view 可以展示变化。因此对话侧需要额外试读或由用户进入资料集设置，属于有限的恢复信息缺失。
5. **新可达路径成立，旧分支必须承认。** `git diff 84740d56..HEAD -- packages/core/src/tool-system/builtin/sources.ts` 明确显示 generic 错误分支原已存在于 uploads-only corpus，当前改变的是 Collection 跨 scope 参数与 adapter 接入。旧基线明确拒绝 Collection 的 `resources` 查询。R49 应只计“新共享资料集路径触发本地原件变更后丢失既有恢复原因”，不要另计旧 uploads generic 问题，也不要宣称 generic 字符串是本轮新增。

## 安全/授权边界是否足以推翻

**不足以推翻，但应约束修复建议。** `shared-document-collection-query-delivery.md:29–33` 明确要求逐文件真实授权和私有 typed receipt，任何拒绝、失败、撤权、取消、原件变化均不得返回部分 corpus；`sources.ts` 的前后授权围栏及 receipt 检查落实了这些要求。这些行为应保留。

同一交付说明 `:25` 也明确写明“原件变化时先阻断读取并要求显式更新资料集”。目前阻断正确，但跨文件响应丢失了已由 Core 检出的更新原因。上述设计没有要求将所有失败都隐藏成同一文案。单文件工具已对已授权的精确资源给出版本变化诊断，故向同一已选 corpus 返回安全的诊断类型与选择 ID，并不要求放行正文或制造可信 receipt。

原报告“真正 `result.isError` 时保留经清洗/限长子错误”的建议仍偏宽：`result.error` 不应自动成为可信来源证据，也不宜无条件回显任意 Hook/adapter 错误、原件路径或秘密。更稳妥的建议是为 Core 已知的版本变化提供可识别的安全诊断和已选 scope/resource，保留拒绝和未知/无 receipt 的兜底，始终不返回部分正文。诊断的可用性与正文授权是不同边界。

## “实际 Engine 仅父 tool_result”证据可靠性

**对被测正常路径可靠。** fixture 用的是已构建生产 `Engine`、`ToolExecutor`、Registry、permission、Collection adapter；只有 LLM client 以进程内固定响应代替外部模型。它第一轮实际发起父 `ReadSource`，第二轮读取 Engine 生成的 messages，并同时收集真实 `onStream`。

实测 stream 只有 `round6-corpus` 的一条父 `tool_result`，下一轮 client 也只看到同一 generic 错误，未看到更新指引和失败 scope。静态代码独立支持结果：`executor.ts:611–639` 的 bound 执行创建嵌套 executor 并直接返回结果；`turn-loop.ts:1667–1691` 只对外层 queue drain 的 results 写入 transcript / messages 并发出 `tool_result`。嵌套 executor 仍有日志、记录与 Hook 通道（`:692–718`），但没有自动把各子结果另行加入模型会话的机制。

限制：本 fixture 关闭 Hooks，不能宣称任意自定义 Hook 或其他 observability 消费者永远看不到子原因；也不是完整 Electron 端到端 UI 测试。它充分验证标准 Engine 对话通道不会自动弥补父层诊断缺失。无需真实模型才能证明该接线。

## 证据强度与最终取舍

- `recovery.log`：4 tests、32 expectations、0 failures；覆盖变更/单读/refresh、拒绝后重试、实际 Engine 会话、revision 冲突后恢复。
- `existing-query.log`：65 tests、374 expectations、0 failures；覆盖逐项授权、Hook 改参、可信 receipt、撤权、版本/目录替换、取消及预算等。没有把 fail-closed 要求当作缺陷。
- observations 记录实际基线及 dist hash、隔离运行时信息、5 个导入前负向探针、0 意外网络请求。JS transport guard 不代表 OS 网络沙箱；报告已正确限定。

本审计没有发现测试虚构因果、生产门禁阻断正常触发、或可以消除此问题的自动对话回填。若整个 review 只接受“全新错误分支”，可按该人为范围排除；但对于新功能的可用性审查，继承旧 helper 后新增正常可达且丢失既有恢复指引的问题仍是一个可行动的 P3。建议计入 R49，一项即可。

## 追加：语音 W17 候选独立复核

**建议另计一项 P2：Desktop 在录音启动等待期间允许重复启动，停止或组件卸载只能回收最后一份录音。** 适用标准 Desktop `ChatView`，主聊天与 Quick Chat 共用该实现；不适用于已有 `requesting` 状态及 generation 围栏的 Web Panel audio capture。`git diff 84740d56..a66f4ef2 -- packages/desktop/src/renderer/ChatView.tsx` 为空，因此是旧快照已存在、本轮新发现的问题，不是本轮代码新增的回归。

### 可达性及完整因果

- 必要条件是可用 STT 配置 / conversation root、组件不在 compacting、两次 `ensureMicAccess` / `getUserMedia` 都成功，并且用户在首个启动完成前再次点击。无需无权限使用设备：已获 macOS 许可时 `main/index.ts:4704–4709` 直接授予，其他平台同样返回 true；该 IPC 不串行录音启动。
- `ChatView.tsx:597–607` 在两个 await 前后都没有同步启动锁或 `requesting` 状态；直到 `:632` 才从 idle 切到 recording。`onVoiceClick` 的 `:666–670` 仍按 idle 发起第二次启动，按钮 `:2106–2109` 也没有禁止等待中的再次点击。这是正常按钮入口，异步设备获取可合理跨越两次点击。
- 两次成功会各自创建、启动 `MediaRecorder`；第二次 `:612/:630` 覆盖唯一 stream / recorder ref，`:634–639` 还清掉第一份超时器并使剩余超时器只操作当前 ref。首份录音不会因第二份启动自动停止。
- 用户停止时 `:657–663` 只 stop 当前 ref；第二份 onstop 仅释放其闭包中的 stream（`:621–628`），随后 UI 可回到 idle。卸载 cleanup `:519–535` 同样只拥有最后一个 ref，无法找回首份资源。120 秒上限不覆盖已经遗失的第一份 recorder。

### Fixture 没有人为跨卸载制造

`voice-lifecycle.test.tsx` 首项在**同一次 mount**内先后点击两次，确认两次 getUserMedia 都已调用，再依次 resolve 两个 deferred promise，确认两个 recorder 均 recording，之后点击停止，最后才 unmount。日志 `VOICE_DOUBLE_START_LEAK` 为 started 2 / stopped 1 / 第一 track stop 次数 0 / 卸载后第一 recorder 仍 recording。没有 remount 后复用旧 `mountedRef`，也没有把新组件资源交给旧组件。

fixture 直接调用实际已渲染 button 的 `onClick`，每次先断言 disabled=false，并在 act 内刷新；它代替了 DOM 输入派发，没有绕过 disabled 门禁。Fake Recorder 的 start 同步改状态、stop 异步触发 onstop，与本问题所需语义一致；它没有完整编码、自动 blob 产生、硬件结束或 document unload，因此只能声称生产组件漏掉 stop / track.stop，而不能声称已经实测真实麦克风时长、内存大小或所有浏览器。

正常对照有价值：单次录音卸载会 stop recorder 和 track；卸载发生在 getUserMedia pending 时，迟到 stream 会被释放且不会创建 recorder；拒绝后重试正常。它们表明本候选是重复启动覆盖所有权，不是泛泛声称组件没有卸载清理。作者随后追加两个 Web dialog 正常恢复对照，最终日志合计 9 tests / 87 expectations / 0 failures / 0 skipped；本审计已读最终 findings 和日志，没有重跑。

### 浏览器语义核对及范围限制

W3C 的 source/track 模型允许连续 getUserMedia 对同一设备建立独立 track；结束一条 track 不会结束仍依赖同一 source 的其他 track。React 组件卸载也不属于浏览器 document unload。真正 document unload 时 UA 必须停止该 global 的 sources，因此不能写成“关闭窗口或退出应用后仍永久监听”。这些语义支持两份成功 stream 的 fixture，且明确了它不覆盖的环境边界。[Media Capture and Streams：MediaStreamTrack 与 source 生命周期](https://www.w3.org/TR/mediacapture-streams/#mediastreamtrack)

MediaRecorder 的 start / stop 针对各自实例，全部记录 track ended 时才自动结束该实例；停止第二个 recorder 没有停止第一个的规则。[MediaStream Recording：方法和结束条件](https://www.w3.org/TR/mediastream-recording/#methods)

也检查了 Chromium 130 的原始实现以挑战 fixture 静态 instances 数组保活是否虚构泄漏：`MediaRecorder` 继承 `ActiveScriptWrappable`，`HasPendingActivity()` 在非 inactive 时为真，因此实际 recording 对象不会仅因 React ref 被覆盖就靠立即 GC 清理。其 `ContextDestroyed()` 会停 handler，进一步支持“组件卸载”和“renderer/document 销毁”必须区分。这里是源码语义核对，没有启动真实设备或浏览器硬件实验。[Chromium 130 MediaRecorder 声明](https://raw.githubusercontent.com/chromium/chromium/130.0.6723.191/third_party/blink/renderer/modules/mediarecorder/media_recorder.h)、[Chromium 130 ContextDestroyed 实现](https://raw.githubusercontent.com/chromium/chromium/130.0.6723.191/third_party/blink/renderer/modules/mediarecorder/media_recorder.cc)

实际环境可能在权限拒绝、设备被占用、codec / resource 失败、用户撤权或 UA 结束 track 时避免/终止录音；报告应限定两次请求均成功，不能声称每次双击都能复现。已配置语音功能的标准使用路径满足条件，不因未配置时的按钮禁用而不可达。

### 分级、重复和修复方向

P2 合适：用户明确停止后 UI 已结束，但同一 renderer document 内第一份麦克风 track / recorder 仍可持续活动，组件切走也没有主动回收；这是用户控制和设备资源生命周期问题，比单纯提示缺失更严重。未证明私密音频外传、付费转写自动发生或最终文档关闭后继续采集，不宜 P1 或称权限绕过。

与 R04（斜杠异步展开迟到覆盖另会话草稿）、R05（附件状态缺少会话归属）不重复。那些修复需要绑定目标会话 / 草稿所有权；W17 需要在首个 await 前同步取得录音启动所有权，阻止或取代并清理并发尝试，并让 recorder/stream/超时器按同一尝试管理。三者仅共用组件，不是同一缺陷拆项。转写失败没有重试音频的现状属于另一个产品恢复能力取舍，本测试未证明其违反承诺，不应伴随 W17 再计一项。

测试防护描述需保持精确：当前 voice fixture 只替换 `globalThis.fetch`，不能称为“所有网络 API 都已阻断”。`window.codeshell` 的 STT 接口和设备均是合成 mock，无真实 provider 调用；这与完整网络 confinement 是不同的证据。作者最终 findings 已采用此限定并纠正脚本注释。本审计只额外读取公开 W3C/Chromium 文档，没有调用硬件、实际 STT 或付费 API。
