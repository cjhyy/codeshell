# 独立复核：Root undo selectors

复核者：第十九批 stream-timing agent。冻结基线 `5f5cf69df8526470700712a4dc2d5ae6bd2da132`。仅只读检查 [Root 报告](../undo-selectors.md)、fixture、首次 raw/exit、预检、manifest、去重记录和选定源码；只写本复核文件。没有运行测试、导入产品、做新实验或 Git 写入；`git show` 只用于比对冻结 blob。

结论：**没有阻塞审计文档集成的问题**。0 项正式、0 项候选、0 项 related 的边界合理；不能把这份纯选择器验证扩大为实际 undo/redo 或旧问题已经修复。

| 核对项 | 独立观察 |
| --- | --- |
| 实际叶与 fixture | 完整阅读 `undo-target.ts` 及现有测试。唯一产品 import 为 `import type ... from "./file-history.js"`，不加载 FileHistory；四个 export 均由现有或 focused 测试实际调用。新增 fixture 的 backup/path/hash 字符串只当自有元数据，没有读写这些路径。 |
| 首次收据 | [raw](root-undo.first.raw.log) 为 `29 pass / 0 fail / 49 expect() calls`，并有 `Completed Bun shard: 29 tests, 0 skipped; 0 failures.`；[exit](root-undo.first.exit.json) 为 exit 0、attempts 1、reruns 0。raw 的 25 个现有测试和 4 个 focused 标题与源码相符；focused 11 断言加现有 38 断言等于 49。raw 与 exit 先保存再检查的顺序由 Root 的执行记录和报告声明，本次没有重跑来重建该收据。 |
| 正常选择合同 | 最大 turnSeq 优先于墙上时间；同 turn 同文件取较早 snapshot；undone 行排除；pending redo 选最低 turn，更新 live turn 使 redo 不可用；whole-session 的同时间基线稳定。这些均与实际选择器源码和 fixture 断言相符。负 epoch 只作为 legacy 数值合同控制，报告没有称为当前 TUI 普通生产输入。 |
| 静态消费者边界 | 选读 TUI `utility-commands.ts:35–160`、FileHistory `:138–185`、`:306–324`、`:850–892`。当前 TUI 最近一轮调用 `getLatestTurnUndoPlan`；不能由 `latestTurnUndoTargets` 的通过证明当前 plan、命令预览或真实恢复。`latestUndoTarget` 不排除 undone 的线索没有在缺普通消费者合同下被提升为用户 bug。 |
| 老 created-only 问题 | [P1-28](../../../bugs/2026-07-13-repo-audit.md:241) 已记录 created markers 无 pre-edit snapshot 时 UI 认为不可撤销。当前 plan 静态源码同时考虑 snapshot 与 created marker；Root 正确仅把这一点用于排重，没有测试旧缺陷、计新增项或声称动态修复。 |
| 哈希与范围 | [source manifest](root-source-manifest.json) 的 15 文件逐项 current SHA、冻结 Git blob SHA 和 bytes 全部匹配；[preflight](root-undo-preflight.json) 的 3 pins（叶、既有测试、focused fixture）当前 SHA/bytes 全匹配。完整文件哈希没有被冒充未读源码的完整运行覆盖。报告 6 个本地链接均存在。 |
| 去重 | [dedup](root-dedup.json) 为 1,161 MD + 889 JSON、260,970 字符串叶 / 363,859 标量叶、0 parse errors。61/55/15/5 为四 pattern 的总命中；当前各自的保存上下文数也为 61/55/15/5，均未触及每类 120 上限。脚本递归解析 JSON scalar values，排除当前批且包含 archives；统计与上下文上限区分明确。created-only 的具体旧记录已另行核对，未以关键词无命中推导语义穷尽。 |
| 跳过 | [navigation skip](root-navigation-skip.md) 是猜错历史文档名的 `sed` 首次响应，非 Bun/依赖/产品失败。既有 earlyInput、usage 和旧 recorder 等排除没有被这次选择器测试恢复。 |

复核时 raw 共 2,934 bytes，SHA-256 为 `c052304e2389bf3d5ec1dd9985053d538e7ecee53496386686494e38fe477116`。fixture 的 preflight SHA 为 `560db8571ca7fa07eee1d798296eb8b3c391f6aa96b8274dabe1643429619ebc`，现有测试为 `7f27451c9d7536258c1532e8fbc01c80973c95661e794933c7da0b4c7b9eebf0`，实际叶为 `ec84eced06a0288a7cfd65526056a05457650fa17f4e20890310f5acdc561063`，均一致。

复核元数据说明：首次批量只读输出超过 tool 输出预算（原统计 12,972 tokens），部分 source/test 与较大 JSON 显示截断。随后分别重新读取同一 `undo-target.ts`、现有测试、选定 consumer 片段，并以结构化小字段读取 dedup 统计、created 相关上下文及逐文件哈希结果；这只是读取已有证据，没有生成替代产品验证或重跑。没有修改 Root 报告、fixture、raw、exit、manifest 或去重记录。
