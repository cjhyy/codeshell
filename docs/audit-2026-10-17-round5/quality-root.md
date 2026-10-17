# 主审质量与材料核对

本批冻结测试源码 `9a421b3e65d5bfe662b78062cb86bd99483a683a`，确认5项（3 P2、2 P3）。仅记录审查材料，未修产品。

主审核对全部报告、首次fixture/raw log、源码位置和当前调用链。Web detail 与 error 共用主/子状态作用域根因，合并为一项；Profile错源与误删共用目录键碰撞，合并；LINE label与URI超限共用平台投影缺约束，合并。Prompt按声明的扫描顺序合同限定P3，不推测模型冲突指令服从结果。Web orphan仅普通附注显示差异，限定支持的乱序回填条件，不称生产WS实际乱序或敏感泄露。

成功首跑逐组计数：Root Web 4/15和1/8，Prompt 2/14和4/19，Profile catalog4/21及既有7文件baseline86/207，Chat3/46。共 **7 shard、104 pass、330 expect、0 fail、0 skipped**。其中18聚焦验证/controls、86既有profile/run-setup测试。共享日志按执行计一次，不能为多个finding重复加数。测试通过证明当前错误行为或正常对照，没有产品修复。

三份独立只读复核已完成：[quality-prompt](quality-prompt.md) 支持Web/Profile/Chat，[quality-profile](quality-profile.md) 支持Prompt/Web，[quality-chat](quality-chat.md) 支持Profile。新增产品执行0。接受的材料修正仅为Web源码行号精度；原fixture/raw日志不变。Profile复核时Root结构化收据尚未生成，报告明确披露；最终结构化源码/证据哈希由主审另核对，不冒称已被早期复核覆盖。

主审另外独立打开LINE官方 [Markdown规范](https://developers.line.biz/en/reference/messaging-api/index.html.md) 的23057–23108动作标签表、23173–23201 URI节，确认buttons所属非image-carousel template的标签20及URI1000字段限制。只用ASCII长度边界证明当前接受的输入超限，不涉及Unicode计量歧义。真实平台验证/拒绝/投递没有执行，fake HTTP200只用来观察payload。

没有失败guarded产品shard。WhatsApp主源首次open Internal Error后跳过；DingTalk精确响应契约不足保持候选。Prompt一次Python计数解析失败在assembly-note里明确为tool response转录，随后只按不变日志修正元数据，未修fixture/重跑或算产品缺陷。以前失败CLI、recorder、summary、Discord方向未继续。

并发main变更正常吸收，见 [integration-context](integration-context.md)。缺陷直接实现未变，Engine和工具选择相关差异只作静态检查；首次测试和source manifest SHA继续指向冻结Git blob，没有对新main重跑或采用另一任务门禁。本批没有全仓build/typecheck/lint/全测试、真实Engine/Host/WS/DOM/Native/平台/账号验收声明。

材料检查包含唯一ID/标题与冻结源码行号、本地Markdown链接、冻结源码SHA、总evidence-index SHA、七份完整首次日志、各自exit0和clean总计、staged路径仅本任务目录。七份被ignore的raw `.log` 在自有evidence目录显式纳入。主目录status/既有tracked diff/四个未跟踪文件SHA在整合前后验证。持续goal保持active，worktree仍用于后续审查。
