# Runtime：保留正常运行中的并发辅助用量

日期：2026-10-10。本记录是源码交付，不表示已发行；不替代真实 provider 账单对照。

## 实际缺口

同一 Session 的 R2 正常运行时，R1 的异步 title/memory 或独立辅助请求可以合法更新磁盘累计。
R2 的 heartbeat/final 原先仍保存「run 起始累计 + R2 用量」的绝对值，覆盖这个已经提交的增量。
例如磁盘原有 100、辅助请求加 30、R2 加 20，冷状态可能回退为 120，而不是 150。
receipt ledger 本身保留计费记录；缺口在 Session 累计、缓存的 cost snapshot 和累计显示事件。

## 最小修复

正常 heartbeat/final 与关闭交接使用同一个 run 自身的 accounting checkpoint。保存前捕获固定的
own usage 增量，每次 revision CAS 都读取最新磁盘累计并加上该增量，重新获取 ledger cost。
只有成功的 CAS 才确认当时捕获的 checkpoint；失败、重复保存及在保存返回前新到的用量均不会
错误确认或重复相加。runId、Session incarnation、close epoch 与既有 field projection 保持原边界。

final 后的辅助计费通过原 SessionManager 的 latest-state 加法事务提交。返回值仅包含成功提交的
accounting 字段及 revision；同 run 只确认该辅助请求的增量，不能顺带确认之前保存失败的主请求。
旧 R1 callback 不推进 R2 的 checkpoint 或替换其 live accounting。cost getter 在 CAS 重试时重新读取。

累计 `usage_update` 只在成功保存后发送；final 事件在 end hook 的异步等待之前立即构造，避免读取
hook 已修改、尚未持久化的 live 状态。该事件表示累计快照，consumer 不应再次相加。TUI 的 context
读数排除 `session_cumulative`，继续接受 provider、estimate 和旧协议的正数 context 读数。
当前单轮 provider/context 和 Run footer 的含义不变。

## 验收

沿用独立进程的实际 Engine/Runtime/ChatSessionManager fixture，保留原 14 项关闭场景并增加 7 项：

- R1 title 在 R2 active 时合法提交，R2 正常结束保留该累计。
- 已成功 heartbeat 后再有独立辅助用量与新主请求，磁盘和 live 累计一致。
- 重复 heartbeat/final 不双计；CAS 重试保留中途增加的外来用量和新 receipt。
- winning CAS 捕获后、返回前的新 own usage 留给下一次提交。
- heartbeat 失败不推进 checkpoint、不发送虚假累计，final 重试补齐。
- successor 接管后，旧 run 不能修改状态或发布它的累计。
- progress/final 均失败后晚到辅助计费成功，只确认辅助增量，随后 close 补齐未提交主用量。

核心数值为主请求 `18 + 16`、辅助请求 `7`，最终 `41`；prompt 累计 `29`、cache read `5`。
失败 final 场景中磁盘 `18 → 25`，checkpoint 也为 `25`，close 后补齐为 `41`。
另核对每个 final 累计事件与发送瞬间的实际磁盘字段相等。

源验收为 21 项实际 Engine 场景、19 项 finalize/generation 回归、5 项实际 TUI App 事件回归，
全部零失败、零跳过。fixture 在首次 Core 动态 import 前安装 HTTP deny-all guard 并完成八项负探针，
保留真实 PID/PPID、private HOME 摘要和合成状态证据。模型响应由内存 fake provider 产生，
没有 worker、真实账号、真实模型或 HTTP 请求；JS guard 不等于 OS 网络沙箱。

正常合入最新主干后，串行 package release gate 完成 9 tarball / 47 typed entry / 45 runtime
import；全量 build 与 12 工作区 typecheck、95 项相关回归、独立 wrapper 的上述 21 项实际
Engine 场景及 5 项 TUI App 回归通过。ESLint 为零错误、105 条既有 baseline warning；
Prettier、engine-bypass、workflow paths 和 architecture/package boundaries 检查通过。
Engine 为 5,001 行，低于既有 5,024 行预算，未调整预算。

## 保留边界

关闭 epoch 撤销后的 foreign R1 callback 仍不能写 legacy 累计；其 ledger receipt 与冷累计可能不同，
不通过当前 R2 的授权补写旧 run。任意永不 settled 的工作、真实 provider 账单、发行安装器与 GUI
部署不在本 fixture 的证明范围。归档账本、Hook 资源授权和 journal prototype 不属于本次改动。
