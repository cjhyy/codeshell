# CodeShell 从零审查：25 项确认问题

本轮记录 **25 项：21 P2、4 P3**，产品代码未修改。24 项有局部动态复现，发布脚本 1 项为静态可达结论。包含旧已确认仍存在的 C02，以及 3 项旧静态线索的补证，不能全部称为首次发现。每项的源码位置、触发条件、实际/预期、影响和验证边界见分报告。

审查冻结于 **`66ee7737a7d6203319834e601c84afe6757f801e`**，日期 2026-10-16（Asia/Singapore）。从仓库规范和当前源码开始，按 14 个包分工审查；旧报告只用于查重。仓库有 7,069 个 tracked 文件，核心代码/测试/脚本入口库存 4,885 个，**库存不等于逐行覆盖**。本轮未穷尽所有文件、运行环境和行为分支，见 [覆盖矩阵](coverage.md) 与 [未确认候选](candidates.md)。

建议先处理补丁回滚和撤销的数据完整性、Chat 账号身份与接收耐久性，再处理模式/运行终态与搜索恢复。下表是本轮全部确认项，不含未完成候选。

| 编号 | 级别 | 问题与精确影响 | 证据详情 |
| --- | --- | --- | --- |
| A02 | P2 | 补丁失败回滚将被删二进制转成 UTF-8，原始字节和执行权限不能完整恢复 | [Coding](root.md) |
| C04 | P2 | 相对 Write 的备份按 Host cwd 定位，undo 返回成功但实际工作区修改仍在 | [Core](core.md) |
| SWC-01 | P2 | 同渠道多账号顺序改变后，持久消息恢复到另一账号 | [Chat](server-web-chat.md) |
| SWC-02 | P2 | 去重键缺账号身份，第二个账号的合法输入被当重复成功接收 | [Chat](server-web-chat.md) |
| SWC-03 | P2 | 小附件 I/O 失败无告警降级内存队列，接收后重启无法恢复 | [Chat，含有意 fallback 边界](server-web-chat.md) |
| A07 | P2 | `/permissions plan` 报 live 成功，却只改 detached 引擎，当前会话仍旧模式 | [TUI / 协议](root.md) |
| C02 | P2 | hook 改参后不再检查 Plan/MCP 最终参数策略；旧已知仍存在 | [Core](core.md) |
| C03 | P2 | `rg --pre` / `npm audit fix` 被误分只读，Plan gate 将参数交给 handler | [Core；未执行实际命令](core.md) |
| C01 | P2 | OpenAI SSE 缺终止证据的正常 EOF 被人为补 stop，半截回答标 completed | [Core](core.md) |
| A05 | P2 | `/commit` 无视合法 model_error 终态，仍用非空旧正文实际提交 | [TUI](root.md) |
| A06 | P2 | `/commit` 提示只含未暂存 diff，实际提交还包含此前已暂存内容 | [TUI](root.md) |
| A08 | P2 | 自定义 session 存储根未返回给 `/undo`，命令读错目录、无法撤销 | [TUI](root.md) |
| A09 | P2 | `/undo all` 只看 snapshots，忽略新建文件；普通单轮 undo 可删除同一文件 | [TUI](root.md) |
| A01 | P2 | ApplyPatch 成功移动脚本后新文件丢失执行位 | [Coding](root.md) |
| A10 | P2 | headless run 的显式模型/端点被 seed catalog 默认值覆盖；apiKey 覆盖也遗漏 | [CLI；动态/静态分账](root.md) |
| SWC-04 | P2 | 合法省略 Matrix botUserId 时自己的回复进入输入，产生回复回环 | [Chat；内存平台替身](server-web-chat.md) |
| SWC-05 | P2 | 单个 state.json 为 null/数字可使整个磁盘会话查询 reject | [Server](server-web-chat.md) |
| D01 | P2 | Git 中文/特殊文件名未解码，@ 搜索不到真实名或返回不可读路径 | [Desktop](desktop.md) |
| D02 | P2 | 多根搜索先全局截断再筛当前根，当前根真实匹配会消失 | [Desktop](desktop.md) |
| D03 | P2 | Native JSON-lines 每 chunk 解 UTF-8，合法分片会把中文/emoji 改成乱码 | [Desktop；仅 decoder](desktop.md) |
| A11 | P2 | release --push 可在任务分支给未合入 main 的 HEAD 打发布 tag | [根脚本；仅静态](root.md) |
| A03 | P3 | 首条未暂存 git status 前导空格被 trim，模型上下文中的文件名缺首字符 | [Coding](root.md) |
| A04 | P3 | 合法提交标题里的竖线截断标题，并把作者/日期字段错位 | [Coding](root.md) |
| A12 | P3 | 父代理最终正文为空时，JSON fallback 可能采用子代理 delta | [TUI](root.md) |
| SWC-06 | P3 | 相同目录 mtime 下排序/游标 comparator 不一致，混合大小写会话分页漏项 | [Server；自然生产相等 mtime 未证明](server-web-chat.md) |

## 验证收据

新问题的聚焦测试为 **33 个不同测试**：root 12、Core 6、Desktop 6、Server/Chat 9。它们断言当前缺陷和正常对照，**通过不代表 bug 已修复**。Server/Chat 9 项只保留了原会话 stdout 的逐字摘录，未保留 runner 原始磁盘日志/JUnit；其余聚焦测试有当次重定向日志。全部用 guarded runner 隔离 HOME；局部 service、内存替身、真实临时 Git/磁盘和纯 decoder 的层级均逐条说明。

既有 baseline：Coding/Arena/Optimization Lab 253 项，TUI 等 150 项，根脚本 42 项，Core/Host/Pet 135 项，Web 121 项，Chat 71 项，Link/CDP/devtools 104 项均完成。Server 初次 121 pass / 1 缺 dist 环境失败；局部构建后相关文件 11 项完成，含 10 个重复测试，没有重跑完整 Server 分组。各组和新旧轮次存在重跑，不能把执行次数相加冒充唯一覆盖；详情见 [validation.json](validation.json)。

初次缺 zod 依赖链接、Desktop 未完成候选缺 react-dom/client、非法终态枚举的初稿收据均保留并明确归类；没有将它们计作产品 bug。独立 [质量复核](quality.md) 检查了证据范围，纠正枚举、影响表述与源码行号，新增执行 0。

部分分审被平台内容检查中止，相关动态方向已经停止，没有换工具重试；候选和验证缺口保留。未调用真实付费模型/外部账号/平台消息，未验收完整 Electron/Chrome/Docker/公网/移动设备/Windows/Linux/自动更新；没有执行发布。仅 Server 做过本 worktree 局部构建，未执行全仓 clean build/typecheck/package-release。

## 文件索引

- [机器可读问题清单](findings.json)：25 项、级别、主要源码行、报告行、已知历史和证据类型。
- [覆盖矩阵](coverage.md) / [未确认候选](candidates.md) / [文件库存](inventory.json)。
- [逐次验证分账](validation.json) / [主要源码 SHA-256](source-manifest.json) / [证据 SHA-256 索引](evidence-index.json)。
- [Core / Host / Pet](core.md)、[Desktop](desktop.md)、[Server / Web / Chat / Link / Browser](server-web-chat.md)、[Coding / TUI / Arena / Optimization Lab / 脚本](root.md)。

所有问题均为未修复状态。本目录只新增审查材料、独立复现和日志；没有替用户修产品、推送远端或改动独立 Panel Apps 仓库。
