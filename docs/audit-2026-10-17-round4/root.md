# TUI CLI 与日志审查

冻结基线 `4ee32f28f78b8315112cca77cfc22b2f2f80ced6`。本报告确认 1 项 P3。CLI 聚焦组因夹具导入前失败而跳过，4 条线索保留为候选，不能宣称动态验证通过。产品源码未修改。

## LOG-R4-01 [P3] 日志轮转按 bucket 前缀排序，删掉当天 engine 日志却保留更早 UI 日志

- 位置：`packages/core/src/logging/logger.ts:439–445`，两个实际写入 bucket 在 `:350–361`；TUI 启动调用 `packages/tui/src/bootstrap/setup.ts:24–25`，该处明确意图是保留最近七天，实际常量上限仅七个文件。
- 触发：用户已有七天的 `engine-YYYY-MM-DD.log` 与 `ui-ink-YYYY-MM-DD.log`，当日再次启动 TUI。
- 预期：按日期保留最近诊断记录，至少不应删掉当天 engine 日志却保留六天前 UI 日志。
- 实际：`readdirSync(...).filter(...).sort()` 按整个 basename 排序，所有 `engine-` 都排在 `ui-ink-` 前。14 个文件删前七个后，仅留下七份 UI 日志，包括最早日期；当天已有 engine 日志也消失。随后启动的新 engine 日志不会恢复此前记录。
- 影响：正常重启时丢失最近引擎诊断历史。仅诊断资料损失，不声称 transcript、会话或用户项目文件受损；P3。
- 证据：[独立 fixture](evidence/root-log-retention.test.ts)、[首次原始日志](evidence/root-log-retention.first.log)、[exit](evidence/root-log-retention.exit.txt)。直接调用生产 `rotateLogs`/`getRecentLogs`，文件全在自有 tmp；首跑 2 pass / 7 expect / 0 fail / 0 skipped / Completed，exit 0。单 bucket 八天对照会正确留下最新七天，隔离出跨 bucket 的排序问题。没有启动真实 TUI；启动接线为静态核验。
- 查重：对近期三批 audit 与 `docs/review-2026-10-12/{README,priority-and-coverage}.md`、`docs/review-remaining-2026-10-12/*.md` 的 rotateLogs/rotation/bucket/日志轮转定向核对未发现同根因已确认项。`docs/archive/core-modules/logging.md` 描述七文件上限，不提供按前缀删除最近记录的功能合同。

## CLI 首次失败与跳过

[原始 fixture](evidence/root-cli-data.test.ts) 首次执行在第 13 行向 ESM namespace 的 readonly property 赋值时报错；发生在产品模块动态 import 之前。日志为 [root-cli-data.first.log](evidence/root-cli-data.first.log)，exit 1，0 pass / 1 fail / 1 error，无 Completed。没有业务断言执行，不能把它计为产品 bug。没有修支架、改 import、换方法或重跑这一组。下面四条保留源代码线索，不计本批确认数：

| 临时编号 | 源码线索与候选影响 | 当前证据边界 |
| --- | --- | --- |
| CLI-R4-01 | `packages/tui/src/cli/commands/registry.ts:133–135` 将完整输入按空白拆开再 join，`/image "a  b.png"` 的文件名变成 `a b.png`；App 注册了真实 imageCommand，该命令自身支持双引号空格路径。`/config set`、`/memory add` 内还有相同的内容归一化 | 静态，实际文件/queue 对照没有执行；全参数保真与各命令内部解析属于相关家族，未拆成多个确认 bug |
| CLI-R4-02 | `packages/tui/src/cli/commands/builtin/extra-commands.ts:293–295` 的 `/log` 仍读无 bucket 前缀的 `<date>.log`；当前 logger 写 engine/ui-ink 文件 | 静态，真实 writer+command 首次组未执行；独立 retention 实验测的是删除排序，没有验证或重试这个命令 |
| CLI-R4-03 | `packages/tui/src/cli/commands/builtin/core-commands.ts:433` 的 `/compact` 不传 ctx.sessionId，Server 当前默认 detachedQueryEngine，Engine.forceCompact 无 lastSessionId 则返回 0/0 | 静态；与旧 A07 permission detached 家族相关，但这是另一个命令缺少 session 参数；未执行真实/fake owner 对照，不计新增确认 |
| CLI-R4-04 | 同文件 `/config` 的 `new SettingsManager(ctx.cwd)` 为 project scope，REPL 使用 full scope；可能显示错误的 user-level context.maxTokens | 静态，user 配置/control fixture 未执行。与本轮 Settings YAML writer 问题不同，仍仅列候选 |

未启动真实 Ink/PTY、浏览器、模型、外部 CLI 或账户。额外阅读了 CLI run/runs/input/renderers/options、loop/list-files/image/goal/core/extra/more/utility commands，以及 Core logger/session-recorder/utils/stream-timing/simple-diff 的选择性相邻源码；只读检查不等于所有分支执行覆盖。earlyInput 虽导出但没有找到当前启动调用，不把 escape parser 线索作为正常 TUI bug。simple-diff 的 O(n*m) LCS 成本仅静态观察，未运行压力实验或计为确认项。

## 独立 dev recorder 日期候选：首跑失败后跳过

`packages/core/src/logging/session-recorder.ts:145–147` 按 sid 缓存路径并在判断当前日期之前返回。一个开启 dev recorder 的长回合跨 UTC 午夜后，可能继续写入旧日期目录；`recordSessionEnd` 清缓存，下一回合才能重新选日期。仅诊断文件分桶候选，不是用户会话/Transcript 数据损失。

[独立夹具](evidence/root-recorder-day.test.ts) 采用既有 session-recorder 测试的逐字节临时副本方式，确保 `import.meta.url` 与输出根都在自有 tmp，使用受控时钟；[首次原始日志](evidence/root-recorder-day.first.log) 在第25行输出根控制断言失败：fixture 的 `/var/...` 与 Bun import.meta 的 `/private/var/...` 路径字符串不同。**0 pass / 1 fail / 2 expect / exit 1 / 无 Completed**。仅完成源码字节相等和该路径控制两次断言，尚未写入事件，不能用该收据证明跨日行为；临时目录、时钟和 env 在 finally 恢复。没有改成 realpath、修支架、换方法或重跑。临时测试编号 LOG-R4-02 保持原样，仅作候选，不纳入确认问题索引。
