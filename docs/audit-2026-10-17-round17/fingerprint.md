# 第十七批：客户端 prompt 指纹

冻结源码：`d86db33012dffd5d1849e76b869fa15eb260324f`。本分区 **0 项正式 bug，0 项候选**，没有修改产品。

完整读取 `packages/server/src/client-message-id.ts` 的无依赖同步 `stablePromptHash`，以及 Desktop `appUtils.ts:1–100` 中的对应实现和导入边界。Desktop 模块会运行时导入 transcripts，本批不导入它或现有整个 appUtils 测试；没有通过 broad barrel 运行其他 renderer、权限或存储行为。动态仅导入实际 server leaf，用自有普通 prompt 字符串调用函数。

唯一首次命令：

```text
node scripts/run-bun-test-shard.mjs --timeout 30000 docs/audit-2026-10-17-round17/evidence/root-fingerprint.test.ts
```

[combined raw](evidence/root-fingerprint.first.log)、[exit](evidence/root-fingerprint.first.exit.json) 在查看前落盘：**7 pass / 34 expect / 0 fail / 0 skip，Completed、exit 0**。全部为新增聚焦观察/对照，**6 项调用实际 helper，1 项只读自有源码比较 Desktop/server 函数体及 SHA**。后者不是 Desktop export 执行，也没有编译提取的 Desktop 代码。没有既有 suite 执行主张。

普通输入覆盖空串、英文/中文、多行 prompt、完整 emoji 和组合重音、首尾空白、CRLF/LF 以及自有多段正文。输出保持确定性、base36 形状和现有 UTF-16 length 后缀，helper 不自行 trim 或统一换行。Desktop counterpart 的函数体与 server 原文相等；这只验证当前源码接线一致，不证明所有运行时包产物或 renderer 已加载一致版本。多段正文对照不构成性能基准。

普通生产/消费点仅静态选读：`packages/desktop/src/main/automation-host.ts:320–388` 将 job id 和原 prompt 指纹组成 clientMessageId，并在 announce/run 透传同一值；`renderer/app/useHostSubscriptions.ts:536–558,635–656` 优先使用已提供 id，否则对 trim 后 prompt 构造兼容 fallback；`packages/server/src/mobile-remote/mobile-chat-turn.ts:72–114` 将 session/run identity、trim 后正文与附件 SHA 摘要组合。没有调用任何这些消费路径、Engine、scheduled runner、实际 submit/dedup、附件准备、Host 回调或 UI。不同 prefix/trim 策略仅是静态事实，没有据此声称重复消息、定时任务丢失或真实跨层不一致。

该 helper 是 clientMessageId 的一个部分，当前源码不承诺它本身在所有字符串上唯一。本批不制造数学碰撞来登记 bug，不将其作为认证或安全原语审查。实际 Engine clientMessageId 测试属于更大运行时范围，未替代执行。

[完整历史查重](evidence/root-dedup.json) 覆盖本批外所有 prior docs/bugs MD 和递归 parsed JSON 字符串叶子，含存在的 archive/_archive：**1,134 Markdown + 804 JSON = 1,938 文件，239,449 字符串叶子，0 解析错误**。指纹/identity 合同关键词 23/39 次匹配，保存的上下文上限每类 120，不作语义穷尽证明。历史 implementation plan、客户端去重与 automation 验证记录用于排除覆盖误报，不能当作本次执行结果。

[preflight](evidence/root-fingerprint-preflight.json) 仅核对两份实际源码的存在和冻结 Git bytes，没有 package resolver 或猜测依赖位置。Root 本分区无 metadata 导航失败、失败 Bun shard 或重跑。[source manifest](evidence/root-source-manifest.json) 记录冻结 SHA 与逐文件 full/selected scope；整文件 hash 不扩张阅读或动态覆盖。没有真实模型、付费 API、账户、用户文件、外发消息、产品网络/native/PTY/auth/permission/security/custody/watchdog 实验，没有 build、共享 dependency/dist rebuild 或全 suite/typecheck/lint 通过主张。
