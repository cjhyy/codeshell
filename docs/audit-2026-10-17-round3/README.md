# CodeShell 广度续审（2026-10-17，第三批 checkpoint）

本批确认并记录 **12 项：1 P2、11 P3**，仅写审查材料，未修产品代码。全部问题的源码位置、条件、预期/实际、影响和证据边界见分报告；结构化入口为 [findings.json](findings.json)。

冻结源码基线：0f83bbfdfb8f2c6f31148250bd6544f5325c16e7。任务分支：codex/audit/broad-round3-20261017。使用本聊天已有独立worktree；原主目录既有改动保留。刷新origin后，当前较新的本地main作为审查基线，其相对上一源码基线仅增加审查文档。旧 [10-16](../audit-2026-10-16/README.md) 和 [10-17上一批](../audit-2026-10-17/README.md) 均保持冻结，不能直接把各批数量相加为当前剩余问题数。

| 编号 | 优先级 | 问题 | 详细记录 |
| --- | --- | --- | --- |
| R3-01 | P3 | Codex file_change完成事件丢失修改文件投影 | [root.md](root.md) |
| R3-02 | P3 | Codex MCP结果与失败原因变成不可读摘要 | [root.md](root.md) |
| R3-03 | P3 | Codex JSONL null记录未隔离 | [root.md](root.md) |
| R3-04 | P3 | Windows格式默认room名使用整段cwd并可生成不可读metadata | [root.md](root.md) |
| HL-01 | P3 | 精确GitHub文件路径被trim并合并引用 | [host-link.md](host-link.md) |
| HL-02 | P3 | 长路径默认标签截断Unicode代理对 | [host-link.md](host-link.md) |
| CDP-R3-01 | P3 | 旋转quad点击/hover取到元素外的点 | [cdp-browser.md](cdp-browser.md) |
| CDP-R3-02 | P3 | Shift组合的logical key与text矛盾 | [cdp-browser.md](cdp-browser.md) |
| CDP-R3-03 | P2 | DOM hidden祖先剪枝漏掉显式visible子节点 | [cdp-browser.md](cdp-browser.md) |
| LAB-R3-01 | P3 | Lab反思输入仍选取已更正的旧评分 | [arena-lab.md](arena-lab.md) |
| ARENA-R3-01 | P3 | 缺失或非法peer verdict默认agree并verified | [arena-lab.md](arena-lab.md) |
| ARENA-R3-02 | P3 | Arena裁决早退跳过unresolved收尾 | [arena-lab.md](arena-lab.md) |

验证见 [validation.json](validation.json)：**12 个完整成功首次guarded shard，87 pass /507 expect**，另有32个按名称过滤测试。共享收据只计一次；CDP stdout/stderr每对是一组执行。**1组首次Lab fixture失败独立保留并跳过**，没有修支架或换方式重跑，reviewer cap只列候选。

两项CDP输入缺陷保守按私有legacy SDK范围P3；Arena不被Host加载，Lab默认flag-off，均明确限定为P3。Browser diagnostics的DOM漏报有生产适配器静态消费者，保留P2。Codex协议形状对照源码声明的官方0.142.4版本；null仅损坏记录边界，未证明正常writer会产生。

[主审质量记录](quality-root.md)、[候选/重复/跳过](candidates-and-skips.md)、[覆盖范围](coverage.md)、[源码哈希](source-manifest.json)、[证据哈希](evidence-index.json)。两路完整独立质量turn因模型容量中断，已有片段意见保留；本批不冒称完整独立复核通过，最终源码/收据核对由主审继续完成。CDP分审receipt内旧报告SHA是历史版本，最终报告SHA以总证据索引为准。

材料检查包含源码/证据SHA、编号/行号、收据计数与本地链接。16份被ignore的原始日志显式纳入本审查目录；Lab失败诊断第11行自带一个尾空格，完整diff空白检查因此有一条原始收据例外并原样保留，排除日志后的材料空白检查通过。

所有动态限定本地纯函数、自有tmp/fake adapter或VM实际callback。未启动真实CLI/浏览器/付费模型/平台发送/实验feature，没有全仓build/typecheck/lint或真实OS验收声明。**本批只是持续审查的checkpoint，完整全仓目标仍在进行**；未覆盖范围继续保留，遇到失败方向按用户要求跳过。
