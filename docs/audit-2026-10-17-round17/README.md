# CodeShell 第十七批审查

冻结源码：`d86db33012dffd5d1849e76b869fa15eb260324f`。本批覆盖模型目录、历史消息映射、客户端指纹与 Chat ingress。**新增 1 项确认 P3、3 项候选，0 项新增旧问题关联计数。** 只记录，没有修改产品；持续全仓审查仍在进行。

确认项 **[CHAT-R17-01](frontier.md)**：配置生成器把明确写出的 loopback HTTP `:80` 误判为没有端口。实际纯函数对 `127.0.0.1:80`、`localhost:80`、`[::1]:80` 在 Caddy/Nginx 两种格式均抛错；同样三个主机的 `:8080` 全部正常。根因是 URL 默认端口正规化为空后，`!url.port` 拒绝。README 支持 loopback host:port，静态配置允许 1–65,535，普通 CLI 原样透传参数。只证明配置生成前的拒绝，没有执行 CLI、listener、代理部署或平台请求。[机器 findings](findings.json) 保留精确冻结位置和限制。

| 候选 | 已获得证据 | 未确认边界 |
| --- | --- | --- |
| [CATALOG-R17-C1](catalog.md) | 实际模型目录在 default 缺失/失效时没有 defaultModel，与静态 Core 回退不同 | 现有 Desktop 测试明确允许省略；有效默认合同/Panel 政策待统一，Host 未执行 |
| [CATALOG-R17-C2](catalog.md) | 普通内存编辑器 helpers 保留 id/preset 周围空格，目录 trim 改写身份与标签 | 真实 React/保存/schema/池/worker 未执行；Task 服务也 trim 输入，跨边界政策未确定 |
| [MAPPERS-R17-C1](mappers.md) | 实际 mapper 对历史 start 用位置合成 id，对后续 Room result 保留真实 id | 两个普通自造对象未证明来自同一次在途调用；协议合同和 reducer/UI 后果未验证 |

[候选机器记录](candidates.json) 不定严重级别。[related](related.json) 为空；旧 parser、AskUser/reducer/UI、Host/Link、Chat delivery 等只作排除。另一路旧 Review header-only 源码修复单列在 [基线更新](baseline-refresh.md) / [addressed-sources](addressed-sources.json)，不混入本批新发现、关联或已验证修复计数。

4 组 **首次 guarded Bun shards** 均完整结束：**31 pass / 125 expect / 0 fail / 0 skip**，全部是新增聚焦观察/对照。30 个测试调用实际纯 helpers，1 个只读 Desktop/server 指纹源码进行比较，未导入或编译 Desktop。原始 combined stdout/stderr 与 exit 均先保存再查看，没有产品重跑；通过刻画了当前错误行为与正常对照，不表示产品已修复或完整系统通过。[validation](validation.json) 保存实际命令和各组 scope。

[指纹专项](fingerprint.md) 为 0/0：7/34 验证确定性、形状、UTF-16 length 后缀、Unicode/空白/换行/多段正文和当前 counterpart 源码一致；身份消费者和运行时包产物未执行，不承诺数学唯一或真实任务去重结果。Catalog 动态限四个纯 helper，Mapper 动态限 leaf APIs/普通形状自有对象，Ingress 动态限生成器和内存端点；其余生产/消费链均为静态。

全历史去重覆盖本批外 docs/bugs **1,134 Markdown + 804 JSON = 1,938 文件**，含存在的 archive/_archive，**239,449 JSON 字符串叶子**。部分专项另统计 **335,081 全标量叶子**，口径分开；0 JSON 解析错误。匹配计数与有限上下文上限分开，不宣称语义穷尽。metadata 导航/receipt 顺序/SyntaxWarning/源码 scope 校正均有记录，不当 Bun 或产品失败，不恢复旧失败方向。

四份只读专项复核：[Catalog](evidence/review-catalog.md)、[Mappers](evidence/review-mappers.md)、[Fingerprint](evidence/review-fingerprint.md)、[Frontier](evidence/review-frontier.md)。[source manifest](source-manifest.json) 固定 59 个去重源码/合同路径与 62 次逐 worker 源码核对；[worker integrity](worker-integrity.json) 核对 38 份 worker artifacts。只有单列的旧 Review parser 与当前/main 不同，实际首跑 helper 及其本批选定 worker sources 未变；哈希不扩张 full-file/transitive 覆盖。[evidence index](evidence-index.json) 保存本批 bytes/SHA（自身除外），raw 原样保留。

最终 [汇总只读复核](evidence/review-aggregate.md) 无阻断意见；[Root evidence 复核](evidence/root-qc.md) 记录计数校正和最终提交检查要求。primary 初始/刷新快照分别保留，原有 dirty/untracked 字节不动。没有真实模型、付费 API、账户、用户文件、外发消息、产品网络/native/PTY/auth/permission/security/custody/watchdog 实验，没有共享依赖/dist rebuild、完整 build/typecheck/lint/suite 或 E2E 主张；独立 codeshell-panel-apps 仓库未做本批全量审查。
