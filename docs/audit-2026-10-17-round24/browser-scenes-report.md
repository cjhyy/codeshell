# Web 浏览器场景与场景测试静态复核

冻结点 `c9056c8047a8e75ab2469e59bf1d3fedd9ad7272`。本方向 **0 新正式问题、0 新候选、0 新关联，0 产品/测试尝试**。完整静态读取五个实际文件共 **3,081 行**：Auth driver 1,035、Auth lifecycle test 315、ServiceWorker driver 722、SW test 210、subagent driver 799。没有 import、执行或抽取任何产品/测试函数，也没有新 fixture、VM/AST 运行、浏览器/server/进程/网络/SDK/模型、真实 HOME、认证/权限/security/custody 实验。

## 普通调用与成功条件

这些脚本的普通调用合同来自其实际 CLI 参数检查、Node 隔离环境断言、场景体及最后退出断言，不从旧成功记录推断本轮运行结果。Auth 接受可选 fresh evidence 路径和末尾 `--headed`；SW 接受可选 fresh evidence 路径；subagent 要求 fresh evidence 路径，可额外指定一个完整 local reducer commit。源码均先要求隔离 Node 环境、证据目录与 checkout/outer HOME 分离；这些条件本批没有实际试验。共享 helper 内部由另一分审负责，本方向只核场景调用接线，不扩张为其全部实现覆盖。

| 场景 | 实际源码要求 | 本批证据等级 |
| --- | --- | --- |
| [Auth](../../packages/web/scripts/test-auth-boundary-browser.mjs#L717) | 固定顺序四个操作：pending login 的原生可见性/焦点、旧设备401不结束新登录、显式logout清掉旧pending状态、当前登录401在dialog关闭后仍有效 | 全文静态；没有实际登录、focus、HTTP/WS或UI操作 |
| [ServiceWorker](../../packages/web/scripts/test-service-worker-browser.mjs#L351) | 十一条顺序记录：page/SW proxy拒绝探针，root/mobile公共cache归属，私有API/POST/query不缓存，320px离线/重连，controller incarnation更新，private root navigation离线失败与root offline UI | 全文静态；不推断浏览器/CacheStorage/代理或真实事件已经验证 |
| [subagent](../../packages/web/scripts/test-subagent-state-browser.mjs#L484) | 1280/390两宽度各四case：普通completed snapshot发送一次、background child不改变父发送状态、scoped child error保留父与sibling并可Stop、两种tool result顺序显示一致 | 全文静态；通知/Host回复只是脚本fixture，未运行reducer、浏览器、发送或停止 |

Auth 的 [authOperationsPassed:135](../../packages/web/scripts/test-auth-boundary-browser.mjs#L135) 同时要求四个case名字/顺序/结果、operationsCompleted、错误/blocked/unexpected/lifecycle ledger为空、recording成功、HTTP/WS关闭、blank owner最终检查与custody settled；1004行才把该布尔值交给 cleanup，1013行还要求实际 removal 才写 pass。SW 的 [serviceWorkerOperationsPassed:39](../../packages/web/scripts/test-service-worker-browser.mjs#L39) 要求十一条记录、operationsCompleted、error/ownerDenied为空和无记录失败；680–688行再合并settlement与owner检查以及cleanup结果。SW的`denied`保存预期负探针，与blank owner的`ownerDenied`语义不同，不能把前者非空直接当失败。

subagent 的 [finally:706](../../packages/web/scripts/test-subagent-state-browser.mjs#L706) 在关闭/settlement、进程退出、root signal、server关闭及最终RPC次数检查后写browser日志；770–788行以clean ledger和固定八个case全部通过、failures为空共同决定HOME removal与passed。没有把这些条件当已成立，也没有将场景自己的network/proxy限制说成OS sandbox。

## 失败、清理与收据接线

Auth 在107–133行保存有界诊断并锁存首个failure，run在520–583行先记录失败，再做body/focus/screenshot、context关闭及owner检查；finally按源码接线尝试同一custody settlement、server关闭、日志及收据流程。SW在58–68行保存首个error与recordingFailed，611–700行分别处理场景异常、incognito关闭、owner检查、settlement、proxy关闭、日志和cleanup gate；正常走到694–700行时会重抛已存failure或断言非passing状态，不据此保证任意cleanup异常之后仍完整执行所有收尾。subagent在469–483行将每个action异常标为该case失败，finally再核settled ledgers与总数；不完整case集不能满足operationsPassed。

subagent的case失败消息并没有独立的“必为某个reducer机制”标签：start/locator/poll等异常也可被同一个case捕获。因此“两个控制通过、六个case失败”只靠name/status不能单独证明每次失败都是某个特定根因。它仍可支持固定输入下UI失败与HOME保留的窄合同；没有新增普通false-pass触发或更强反向要求，本批**不升级新候选**，也未把该信息放入正式/关联计数。与helper审查者的静态核对保持这一界限。

[既有发布记录:250–313](../todo/release-real-operations-2026-10-16.md#L250) 已分开记下旧red browser、selected cleanup源段实验、失败HOME保留修复、负验收与64个Node contract tests；272行还明确“成功删除HOME后最后一次report写入失败”的已知局限。它们只作prior，不重新计数、重放、外推本批通过或新增同项。本文没有访问旧绝对`/private/tmp`证据路径。后续源码中final-report在successful removal之后的排序，不据此重复报这个已记边界。

## 场景测试的范围

[Auth lifecycle test](../../packages/web/scripts/test-auth-boundary-browser.lifecycle.test.mjs#L1) 的八个test声明包含源码AST fingerprint、路径/alias拒绝、成功gate、首failure/诊断和blank owner/settlement次序。它会读取/提取函数、使用VM和临时目录，但本批只静态读，**未运行上述动作**。其原callback fingerprint不等于当前浏览器成功。

[SW test](../../packages/web/scripts/test-service-worker-browser.test.mjs#L1) 的九个test声明包含fresh evidence拒绝/不覆盖、实际入口的早期拒绝、failure/gate与原十一operation/proxy AST合同；同样全部未执行。两个文件合计十七个声明不是十七个通过项，不新增assert/pass/expect计数。Subagent实际场景也只静态，旧验收与本轮运行数始终分离。

[旧WEB-R5-01/02](../audit-2026-10-17-round5/root-web.md#L5) 已登记父子状态与orphan result清理机制。当前subagent场景的期待与这些prior相对应，但本轮没有重跑旧reducer或其UI实验、没有新增同机制问题，也没有据场景文本声明已修复/修复验收通过。

## 去重与证据限制

[全历史去重](evidence/browser-scenes-dedup.json) 覆盖既有docs/bugs全部递归MD与parsed JSON标量，含archive/_archive、排除本批：**2,375文件 = 1,223 MD + 1,152 JSON，370,703 string leaves / 523,455 scalar leaves，0 parse errors**。source/receipt-cleanup/case/broad-browser模式分别命中6/0/0/274次，保存6/0/0/150个上下文；零关键词命中不证明没有相关历史，广泛命中也含其它浏览器场景/库存噪声。精确命中主要来自旧round22集成metadata与发布记录，未把路径库存当旧bug，也未声称语义穷尽。人工选读范围和排除依据见 [dedup decisions](evidence/browser-scenes-dedup-decisions.json)。

五个目标文件均为全文静态阅读，逐块连续范围与冻结/current hash见 [source manifest](evidence/browser-scenes-source-manifest.json)。CODESHELL内容此前已全文读，本批重新核其SHA仍相同。所有外部OS/Playwright能力推断都没有作为新事实使用；未调用外部网页、用户账户或任何平台API。本轮无产品失败、修复或重跑，没有恢复旧失败方向，没有共享依赖/dist/build/lint/typecheck/full-suite/E2E。采集Python/Git/rg只处理审查元数据，见 [validation](evidence/browser-scenes-validation.json)、[classification](evidence/browser-scenes-findings.json) 与 [author receipt](evidence/browser-scenes-author-receipt.json)。
