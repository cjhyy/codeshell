# Session fork / context transfer：有限静态审查

**0 正式 / 0 候选 / 0 新关联**。只核正常full、summary、completed-side的数据路径；产品/helper/import/test、真实会话/FS、模型/网络/native及Git执行均0，没有改产品或旧包。

真实协议分支→Engine→SessionManager已选读。Full按冻结事件数组的inclusive cursor截取、显式copy/skip策略验证后，目标深拷贝事件并重分配ID，context note/checkpoint和turn_diff引用在复制前缀内重映射。Side用已完成游标而非进行中的tail，并选择ephemeral；没有把任意工具不配对/伪造event ID当正常反例。目标复制cwd、克隆workspace、model/provider，重置usage/turn计数、invokedSkills与parent；当前parent goal/control不会由buildForkState带入。这里只描述具体字段，不认证整个profile/project授权或跨进程存储机制。

Summary先clone/验证inclusive选区，实际portable serializer递归保留structured tool-result文本、reasoning和参数，图片使用明确metadata占位；正常非空摘要完成后才调用createSummaryFork。目标只有meta+context_transfer、重放为background是该入口合同，不能把“不复制原正文”当丢失。协议使用busy/exclusive调用并在成功后发布，但本包不由调用形状认证互斥/锁。大窗口分片与底层模型/token估计仅显示到边界，不宣称全分支正确。 [精确范围](source-manifest.json)、[已显示摘录](source-excerpts.txt)、[分类/边界](classification.json)保存有限证据。

旧因已亲核并排除：SESSION-R9-01为超工具批次的持久配对阻fork；CTX-1为普通snip前缀配对、CTX-2为普通压缩/归档丢nested文本，后者与此portable serializer不同。 [R9原文](old-session-r9-input.json)、[CTX原文](old-ctx-input.json)及[R9canonical](r9-canonical-inputs.json)/[R32对象](r32-canonical-input.json)保留版本：旧manager935b…/109011B不同当前3a0…/109429B；transcript同SHA的pin也不单独证明全文。旧重叠不叫首次。July is_error/synthetic duplicate仅保留R9引用，不伪称亲读原件；没有重开其失败/多进程方向。另[旧fork/alignment导航](prior-navigation-late.json)只有实际显示行，hash晚于导航且initial=null，不倒填。

[共享batch投影](history-projection.json)记录6010 MD/JSON、纳冻58排59+、4291442 JSON value scalar机器访问（含archive），manager609/transcript548命中各cap100；原hits不穷尽，不能据无条目认unread或新颖性，也不把机器访问加到个人语义/运行数。

范围：5产品selected **830**行，2个测试细节声明selected **121**行（不执行），另2测试仅title导航；合计951，display union **1290**，semantic full0。 [diagnostics](diagnostics.json)保存首次库存原raw exit0、0metadata失败/截断；[ending](ending.json)11源/指令pin、6可比限定metadata输入SHA均同，4份旧MD导航仅late hash，不冒称重核全历史或全Session无bug。见 [自排除收据](artifact-receipt.json)。
