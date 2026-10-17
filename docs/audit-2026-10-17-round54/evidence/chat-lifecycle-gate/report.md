# Chat lifecycle：读前历史全文门槛

本包 **0 正式 / 0 候选 / 0 新增关联**。主目标与唯一 fallback 均按原 canonical 同 SHA 的明确全文记录在当前正文前排除，不选择第三个文件。本次没有进入当前启动、停止、清理、callback/error 或 adapter/caller 源码合同，不能称这些机制已复核或正确。

- `packages/chat/src/lifecycle.ts`：28行 / 824B，SHA `cdf93e75be321a483b0b9d8339cbefe87b9e211549dfdda58f348ef1ab010d46`。原 R20 `evidence/root-source-manifest.json /files/9` 明确 **Full static leaf**，同对象字节/SHA/行数匹配；原 R11 `chat-source-manifest.json /files/9` 为 **full helper read; format candidate not tested**。原 chat.md21记录 Mattermost Markdown button URL/标签旧静态候选及官方资料首次读取失败后 SKIP；本包没有恢复该方向，也不按文件名把旧 helper 阅读升级成生命周期运行证明。
- 唯一 fallback `packages/chat/src/attachments.ts`：93行 / 3512B，SHA `58a2c3b5b566db4d7d3dc1a74bedc371c74972368fae3d9dbf6d400fcd29fc82`。原 R11 `/files/5` 明确 **full ordinary metadata helper read; no bytes loading execution**，frozen/current SHA 同值；原 R20 `/files/6` 明确读取命令到120而实际 **complete 93-line file**。原120命令上限与93实际完整声明分别保留，未静默正规化超 EOF 范围，也未把 loader/bytes/materialization 当作运行验证。

[canonical 原对象与 MD 限定](canonical-evidence.json)保留四个原 source-row 对象和8行专门选读的历史 MD 元数据。R43较晚 hash-only/inventory 不抹去原 full，也不另增加覆盖。旧 N01 只因 path/line 命中不自动认定当前同版本或同因，未重新打开其旧平台消息/队列/持久化方向。[源码清单](source-manifest.json)的 `files=[]`、两个产品 hash-only，semantic/display/test declaration 都0；指令文件本轮只 hash并复用先前同 SHA 阅读。没有普通新反例，因此没有提出或执行 guarded fake 测试计划。

fresh [历史库存](history-inventory.json)纳已冻结正式53、排正式54及以后：**5311 = 1500 MD + 3811 JSON**，recursive JSON values计2575070 strings /3824469 scalars，不把键名当值文本。exact archive路径段162份、substring174份分开。lifecycle path/SHA/叶名命中48/24/119，attachments为45/45/875；每query保存前100上下文，单值cap2000字符并保留原长度/value SHA，完整总数另存，直接 canonical对象不受前100 cap限制。未声称所有机器命中均人工全文读；unknown/no-row/hash不是未读证明，未更新全局覆盖或未修计数。

[ending](ending-checks.json)核四项 source/instruction pins与原5311历史字节；原时点不倒填。产品/helper/fixture/test/Chat/gateway/账户/外部消息/network/native/process/Git 执行均0；未读真实用户数据，未修产品，旧失败动态保持SKIP，见[validation](validation.json)。元数据命令错误0、展示截断0。父上下文 `16c1a40c7e3f0cf7701fccd723293bfb1291f105` 由Root给定，本 agent未查Git。旧全文记录仅支持本次排除门槛，不证明整个Chat无bug。
