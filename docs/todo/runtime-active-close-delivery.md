# Runtime：关闭 active Session 的终态交接

日期：2026-10-09。基于 `origin/main` 的 `229365f9` 验证；本记录是源码交付，
不表示已有版本发布，也不替代真实 provider 账单或 macOS Phase D 系统钥匙串验收。

## 实际缺口

`ChatSessionManager.close()` / `closeAllAsync()` 已等待运行结束，但关闭意图会立即撤销
旧 Engine 的 Session 写入 epoch。实际 Engine 的取消 transcript 和 usage receipt 已完成，
旧 Engine 的终态保存却被正确的 generation fence 拒绝，冷状态仍可能显示 `active`、
旧 turn/累计用量、旧 context anchor 和旧 cost snapshot。直接取消和 Runtime 关闭的对照
正常。这是终态、legacy 累计及冷快照的交接缺口，不是 receipt ledger 或账单丢失。

## 最小修复

关闭仍立即递增 epoch，旧 whole-state 和普通 field writer 立即失效；同一 manager 的
重新获取仍等待运行 settled。关闭 owner 从实际 Engine 的稳定 `{sessionId, runId}` 获取
一次终态授权，在 settled 后提交白名单 run 字段，不重新注册旧 Engine。

授权同时核对旧 Engine 所绑定 epoch、当前 close epoch 和磁盘 runId；一次 close epoch
只发行一次，同一授权只消费一次。写入采用磁盘 revision CAS，每次重试重新读取当前状态、
runId、最终 usage 和 ledger cost。title、workspace、Profile、Goal、模型与 Session 身份
保留当前磁盘值；不同 run 抢占或再次关闭时授权失效。epoch map 是进程内机制，
不宣称跨进程 epoch 隔离；持久 runId 和 revision CAS 阻止覆盖已替换的 run。

累计只加本 run 相对最后成功 accounting checkpoint 的未提交增量，不从全局 Session
累计倒算。旧 run 异步 title/memory 计费不会推进新 run 的 checkpoint 或替换其 live 账。
独立 owner 已合法写入的累计保留；context anchor 只在磁盘仍等于本 Engine 最后成功
写入的 anchor 时更新。收尾 hook 内同 run 的晚到计费在 settled 后纳入。

已 claim 的 run 若在进入模型循环前关闭，也保存取消终态；真正初始化失败仍保存
`model_error`，取消则保存与 ChatSession 返回一致的 `aborted_streaming`。

## 验收

`tests/runtime-active-close-acceptance.test.ts` 在独立受控子进程运行实际 Engine、Runtime、
ChatSessionManager、SessionManager 和内存 fake provider。14 个用例覆盖普通取消、
individual/全量关闭、Runtime 对照、重新打开与 successor fence、不同 run 抢占、关闭前后
独立辅助计费、前 run 迟到 title 计费、pre-loop 取消/失败、成功 progress 后的增量，以及
最终 hook 内同 run 的迟到计费。单元回归另覆盖重复发行/消费、CAS 重试和 metadata 保留。

核心数值对照：首 run `11 + 7 = 18`、cache read `4`；successor 再用 `13 + 3 = 16`，
累计为 `34`，没有双计；同 run 收尾辅助计费再加 `5 + 2 = 7` 后为 `41`。冷状态与真实
transcript/ledger 分别核对，不通过手改 counter JSON 或 mock IPC 构造结果。

guarded runner 提供全新的真实 HOME/USERPROFILE/CS_HOME/TEST_HOME，并移除继承的
provider 凭据及 Host 配置。首次 Core 动态 import 前安装 deny-all 网络 guard，完成八项
negative probe，并保留 PID、PPID、HOME hash 和私有证据 JSON。fixture 没有 worker、
真实模型、外部账号或网络请求；wrapper 有独立总 deadline，并在失败时只清理自己的进程树。

最终 latest-main 组合的 focused 回归为 24 文件、139 项零失败，其中 wrapper 另完成上述
14 项实际 Engine 用例。fresh 安装后 Node/Bun 的 Core/Server SDK→Express→proxy-addr
均为 2.0.8，五项 trust 回归通过。Package release gate 的 9 tarball、47 typed entry、
45 runtime import，全量 build/workspace typecheck、任务 ESLint/Prettier、engine-bypass、
workflow-path 和 architecture guards 均通过。Engine 行数预算按本次具体私有 owner wiring
精确调整为 5,021，无未来功能余量。

## 保留边界

旧 run 的 foreign auxiliary callback 若在 close epoch 撤销之后才完成，普通 Session
writer 仍被 fence 拒绝。本次终态授权不代它扩权：其 durable ledger receipt 可存在并被
fresh cost summary 读取，legacy 累计可能只含已合法提交的部分。对应回归明确核对 ledger
`41` 与冷 legacy `34`，不把两者冒称一致。

本次仅保证被撤销 run 自身未提交用量/终态的窄交接，并保留其他已合法 durable 写入。
关闭之前普通 progress 对独立辅助写入的通用并发计费行为、任意永不 settled 的第三方工作、
真实 transport drain、真实 provider 账单、Electron GUI 和 OS 密钥托管均未由本 fixture 验收。
