# 独立复核：toolsummary lane

结论：材料与所声明的有限验证范围一致，**无阻塞修订**。确认 **0 新正式问题、0 新候选、1 处旧机制关联**；这不是对实际 provider、Engine、TurnLoop 或 UI 链路的通过声明。

先用 `rg --files` 确认作者材料。最初 receipt 未完成时仅预读报告、fixture、validation 和 source manifest；作者最终 `toolsummary-artifact-receipt.json` 出现后才完成文件 hash / 链接核对。没有新测试、产品重跑、产品修改或 Git 写入，只新增本复核文档。

独立核对项：

- 真实 `tool-summary.ts` 全 51 行的唯一 runtime import 是 `../logging/logger.js`，其余是擦除的类型 import。fixture 在动态导入实际 leaf 前，按精确绝对 `logging/logger.ts` 路径注册 mock；mock 只暴露内存 `logger.warn` spy。普通 Error 控制命中该 spy，null / undefined 控制在读取 `.message` 时先成为 TypeError，没有把 logger、client 或 provider 的真实行为计入覆盖。
- 真实 `run-accounting.ts:145–170` 是 auxiliary client callback 生产者；真实 `TurnLoop:1695–1728` 的异步摘要链有尾部 catch。两者只静态读取。作者明确 null / undefined / string 拒绝均由手工 callback 制造，普通 provider producer 未建立，也明确不声称主调用失败、进程崩溃、未处理拒绝或 UI 丢失，结论没有越过证据。
- 旧 `docs/archive/review-2026-05-30/findings.json` 索引 36 / 119 确有任意捕获值直接 `.message` 的机制；本位置降为关联、不给新 severity 合理。索引 44 的数组长度指控及 `backlog_verdicts.json[22]` 的 false_positive 判定已读；当前 queue 按 callOrder 返回结果，registry 的普通失败对象只有 error、成功对象补 result。未恢复错位数组、旧 JSON summary repair 或真实工具方向。
- 首跑 exit receipt 的 command 使用 guarded runner；合并 raw 是 **2005 bytes**，SHA 与 receipt 一致，raw 显示 **14 pass / 42 expect / 0 fail / 0 skip，Completed**。fixture 的 14 个实际 leaf cases 对应 11 个普通控制和 3 个手工拒绝边界；expectations 是当前行为刻画，不是修复验证。preflight fixture SHA 仍匹配；作者收据声明 raw/exit 保存后才查看，未发现改测/重跑材料。
- 独立从冻结 Git blob 和当前文件字节计算 **10 个 source pin**，全部匹配 manifest 的 SHA、bytes 和 lineCount。全部 **16 个作者 artifact** 的 SHA / bytes 匹配最终 receipt；报告 **19 个本地链接**均存在，`#L` 引用行号在范围内。receipt 自身排除符合约定。
- 全历史记录统计为 2109 MD/JSON、267491 string / 373239 scalar，0 parse error；报告区分总计数、最多 30 个上下文、全部 locators 和人工选读，未把关键词当语义穷尽。导航误猜目录与 dedup 展示截断都有 metadata 转录，既未掩盖成产品失败，也未计为测试失败。

复核只支持实际 leaf + 内存 callback/logger 的有限结果，原有对 Unicode、超大输入、真实计时/网络/工具/权限和完整 suite 的排除仍然有效。最终集成时由 root 再核对最终索引与当前 main；本复核没有执行合并。
