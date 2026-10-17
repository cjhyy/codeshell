# 第二十批：聊天媒体类型分类补查

冻结点 `d40dd06987a2e0c20c377e243cf5c4e4b549c9ec`。本分区 **0 确认 / 0 候选 / 0 related**。实际只调用 [`mediaKind`](../../packages/chat/src/media.ts:26)，用普通 MIME/短文件名字符串检查类型标签；没有下载或发送附件、解码媒体、校验 URL 或操作文件。

唯一首次命令：

```text
node scripts/run-bun-test-shard.mjs --timeout 30000 docs/audit-2026-10-17-round20/evidence/root-mediakind.test.ts
```

[原始 combined stdout/stderr](evidence/root-mediakind.first.raw.log) 与 [exit](evidence/root-mediakind.first.exit.json) 先保存再检查：**7 pass / 21 expect / 0 fail / 0 skip，Completed、exit 0**，全部 focused，0 重跑。包括 MIME 大小写/空白/参数、无 MIME 的大写扩展名、短中文/空格/emoji 名称、普通非媒体 fallback、空 MIME、最后扩展名及仅 MIME 值。文件名仅作内存标签。夹具在动态导入实际 module 之前安装 deny-fetch，并在 afterAll 恢复及检查；raw 的 expect 总数直接采用首次输出，不另推算 hook 计数。

整个 mixed media module 已静态阅读以核对 top-level：只有 type imports 和 `node:net` 的 `isIP` builtin import，没有顶层网络调用。真实模块完整导入，实际调用仅 `mediaKind`；没有 mock/摘抄该函数。[预检](evidence/root-mediakind-preflight.json) 核对实际路径、frozen Git bytes、绝对 import 和 guard 先后，没有依赖位置假设。`downloadRemoteAttachment`、URL/private-network guards、outgoing attachment 校验、safeAttachmentName、delivery tracker 均未调用。既有 `media.test.ts` 混合这些方向，只有前 30 行静态阅读，没有运行既有组或从中过滤恢复旧方向。

[`slack.ts:41–54`](../../packages/chat/src/slack.ts:41)、[`teams.ts:120–136`](../../packages/chat/src/teams.ts:120)、[`mattermost.ts:164–180`](../../packages/chat/src/mattermost.ts:164) 的普通 platform metadata 将 MIME/name 交给分类器，之后交给 remoteAttachment；这些 adapter、loader、真实 platform SDK 都未导入或执行。分类结果正常不证明元数据可信、字节类型正确、协议支持全部格式、远端平台可发可收或实际图片可解码。没有为未知格式新增支持要求，也没有把非媒体 MIME 与已知媒体扩展名冲突自造为普通 bug。

[全历史查重](evidence/root-dedup.json)：**2,109 prior docs/bugs 文件 = 1,176 MD + 933 JSON，267,491 string leaves / 373,239 scalar leaves，0 parse errors**，含 archives、排除本批。26/29/30/1 是四类总命中，最多 120 段上下文单独保留。宽泛 MIME/extension pattern 含 extension-module 等误命中，已选择性核对相关记录，关键词不证明语义穷尽。[旧 CHD02](../audit-2026-10-17/chat-data.md:17) 是 safeAttachmentName 的 Unicode 上限切分，本批不调用；[round11 既有排除](../audit-2026-10-17-round11/evidence/chat-candidates.json) 明确不把缺合同的 filename/MIME 冲突或并发 tracker 计 bug，继续排除。旧 WEB-R8-02 处理另一个客户端的 image/jpg 大小归一化，与这里的类型标签不同；只排重背景，没有旧修复或大小限制重测。

[导航/输出 metadata note](evidence/root-navigation-skip.md) 保留一次错误旧路径和一次有界输出截断；相关旧记录另行读回，没有产品验证失败或重跑。[source manifest](evidence/root-source-manifest.json) 精确区分实际 leaf 与相邻静态探索，完整文件 pin 不代表全模块运行覆盖。

没有真实 CLI/模型/付费 API/账户/外部消息/用户文件/product network/native/PTY/权限/auth/security/custody/watchdog 实验；没有共享 deps/dist 重建、build/typecheck/lint/full suite/E2E。相邻 Web format/i18n、source access summary、Markdown lifecycle、query guard 只静态阅读，未恢复旧失败/authority 方向。
