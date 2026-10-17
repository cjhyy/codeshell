# Independent review: Web browser scenes

审查者 `session_title_round22`，冻结点 `c9056c8047a8e75ab2469e59bf1d3fedd9ad7272`。支持作者 **0 新正式、0 新候选、0 新关联、0 产品/测试尝试** 的交付；没有阻断项或需要纠正之处。本复核只读文件与审查元数据，没有 import/执行产品、测试、browser、server、网络、auth/authority/native，也没有提取/VM/AST 执行任何场景函数。

独立核验作者 17 个 artifact 的 bytes/SHA 全部一致；5 个目标 source pin 对照 frozen Git blob 和当前文件全部一致，总计 3081 行（1035+315+722+210+799）。manifest 的 readingChunks 各从第 1 行连续覆盖到实际 EOF，无缺口/重叠/越界。这个核验确认全文阅读声明的范围与字节，不能由 hash 证明全部语义已验证；我没有把独立选段复核冒充重新全文阅读这 3081 行。manifest 只认领五个目标的全文，未认领共享 helper 的传递实现；父记录选读在 dedup decisions 中另列。16 个报告本地链接存在且行号有效。

已选读实际 Auth `authOperationsPassed`、SW `serviceWorkerOperationsPassed` 与 CLI/environment 起始条件，以及 subagent 参数、runCase/最终 cleanup 选段。Auth 4、SW 11、subagent 8 是源码中的期待，现有 8 个 Auth 与 9 个 SW test 声明也只是声明；report/validation 没有把它们算为通过、运行、expect 或额外浏览器行为。validation.runs 为空，所有当前 pass/expect/attempt 都为 0；元数据扫描的 first.exit 不属于产品 shard，不能称本批实际验收。

成功/失败陈述与选段一致：Auth 要固定 case 名序/通过、operationsCompleted、干净错误与 lifecycle ledger、记录成功、server/owner/custody 完成，再要求 privateHomeRemoved；SW 合并其十一条记录与错误/ownerDenied/记录门禁、settlement/owner 检查及 removal，预期代理拒绝的 denied 与 ownerDenied 被正确区分；subagent 需要八个 case 全通过且 failure/ledger 清洁，失败 case 不授权删除 HOME。对任意 cleanup 异常的最终收尾没有给出过强保证，也未把浏览器路由/代理限制称成 OS sandbox。上述均为静态 source contract，没有实际环境或 authority 验证。

旧 [WEB-R5-01/02](../../audit-2026-10-17-round5/root-web.md#L5) 的父子状态与 orphan 清理机制已独立读完旧报告 33 行，当前场景期待与其相关，但作者没有重复计项、重跑旧 reducer 或宣称修复验收通过。[既有发布父记录](../../todo/release-real-operations-2026-10-16.md#L250) 的红/绿/selected cleanup、64 项 Node 合同及 31 browser behaviors 被正确分账，final report 在成功 removal 后可能写失败是已知限制，不是新增本批缺陷。未访问这些父记录中的历史临时路径或真实 HOME。

负例语义限制准确：runCase 会把 action 中任意 Error 记在同一个 case 下，所以固定 2 pass / 6 fail 的 name/status 不能单独分辨每次失败是否都来自预期 reducer 根因。它仍可支持固定 case 失败及 HOME 保留的窄合同。没有普通 false-pass 记录或更强相反合同，保留为证据解释边界，不升级候选。此前 helper 方向的独立静态讨论与本稿一致；没有据此新增输入、fault 或 attack 模拟。

全历史 counts 和 capped contexts 被表述为导航范围，未把零关键词命中当作历史不存在，也未把 round22 路径库存当已完成产品阅读。OS/Playwright、登录/focus、CacheStorage、HTTP/WS、真实 process/HOME 均没有新增事实或执行证明。最终报告 SHA `f17cd1eb7ff0735cd22249509b247b02c923e2e92e299dc3f9d8d4243c96166e`；作者 receipt SHA `17bfccc33c5f5bc1f6f04ac31e53dbc4cb4bb7121ccce30fff61da2072510c74`，核对时点包含全部 17 个自列文件，本审查文件不在作者 receipt 中。
