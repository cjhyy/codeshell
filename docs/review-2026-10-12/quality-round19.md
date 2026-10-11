# 第十九轮最终整合语义审计

Completed。新增测试、原生/helper、网络、worker、Engine、模型、CLI或Electron实验执行均为0；没有修改产品、主报告、fixture、构建产物或goal。只读源码、脚本、已有日志/JSON和报告，保存本审计。结论：支持R77/FM19-1作为单项窄P2；没有发现需要撤回或调整分级的实质矛盾。

已读主审目录的README、flow-coverage、latest-baseline、reproductions/README、progress、file-mutex-round19、file-mutex-quality-round19、原生便携脚本、作者原始成功/四份失败材料、作者post-run-cleanup、两基线最终native log/observations、round19-native-results和round19-report-audit；按相关位置核对latest冻结产品file-mutex、HubAuthStore、Headless HTTP及maintained isolator源码。第十八轮最终审计与Hub标题正常控制边界保留，没有重跑。

## 生产首因与可见影响

正式标题编辑form调用实际业务PATCH `/api/v1/sessions/:id`。已初始化Hub在该请求进入session-management/title mutation之前先认证：HubAuthStore.filePath为dataDir/hub/auth.json，authenticate即使不需刷新lastSeenAt也先mutate/acquireFileLock；Core锁定dirname(auth.json)，proper-lockfile创建该hub目录的sibling dataDir/hub.lock。

故障注入是owned dataDir自身0700→0500，而不是dirname(dataDir)。hub子目录已经存在，仍可读/遍历并可由同一uid chmod700；Auth ensureDirectory只修hub权限，没有修其parent dataDir。因此实际mkdir(dataDir/hub.lock)失败。两基线firstError.path均精确为该auth lock，actualFailureStage均为HubAuthStore.authenticate/acquireFileLock(data/hub/auth.json)。失败response是Headless外层500 “server request failed”，不是title handler中文500；未抵达title handler。已建title anchor只为正常/字节对照，并不是触发auth锁故障的必要条件。

file-mutex.ts:95–112捕获所有lockSync错误后同步Atomics.wait退避，默认30,000ms；没有筛真正争用ELOCKED。观察包装真实graceful-fs.mkdirSync，委托原实现并原样rethrow同一error，不合成EACCES、不替换timeout/sleep/lockSync结果；路径先realpath规范化避免过滤漏收据。真实依赖将非EEXIST原错立即回传，重复预算由仓库外层引入。

caller与Host分属自有进程，首个EACCES收据后才发无需认证的fresh /health；Host20ms interval独立记录长间隔，parent100ms interval继续。由此不只是客户端单请求等待的推断：同一Host JS事件循环被同步等待占据，健康route与timer不能及时处理。不能扩大为独立worker计算也停止、所有任务失败、OS网络停止、crash、数据丢失、匿名安全攻击或永久死锁。

本报告中原“所有/api请求先认证”的简写应限未被公开/auth handlers处理的业务API，包含本次title PATCH。headless-server:723–726先允许links.handlePublic、panels.handleAssets、hubAuth.handle返回；setup/login等公开认证入口不能套入该泛称。root已修正文与末尾link label，我已读修订为“未被公开/auth handler提前处理的 /api/ 业务请求（含本次title PATCH）”和“本次业务API前认证”；不改变实际请求首因或分级。

## 原生收据、计数和恢复

主审两基线最终原生收据均Node25.8.1/darwin arm64/uid501、38个Node手工assert、failure=null、closedNormally=true，host/holder均exit0且signal null，workerCreated=false、generation0；两个最终log均Completed。source SHA256收据相同，不靠产品源码无差异替代执行。

| 主审基线 | title PATCH500 | fresh health200 | Host20ms timer最大gap | 修权限ENV / 同稿title | 正常短争用 |
| --- | --- | --- | --- | --- | --- |
| 84740 | 30026.84ms | 30021.92ms | 30034.15ms | 3.27 / 9.51ms，均200 | 403.81ms200 |
| a66f | 30035.69ms | 30028.49ms | 30044.58ms | 3.91 / 9.87ms，均200 | 389.61ms200 |

两基线分别838/856次真实EACCES，parent计时器各296ticks；正常helper另进程持生产auth锁350ms后释放，native mkdir EEXIST分别13/12次，最后成功且auth/title锁释放。底层观测EEXIST不能写成外层直接catch EEXIST：依赖会将正常活动锁争用转ELOCKED。该控制支持保留真实跨进程锁与适当争用退避，不支持无锁写入或删除认证门禁。

权限故障未写title，原title字节保留；修owned dataDir回0700后原Cookie ENV与相同title/expectedTitle重试及时200，detail新customTitle、generated title仍保留。该恢复是实际API，没有本轮浏览器点击；UI错误保稿/解除busy本轮仅源码及第十八轮既有真实组件控制。不是一般只读盘/坏磁盘全部恢复保证。

作者原始latest成功另为1次/38，表中主审两次与作者不累计成一个114断言suite。前四份诊断单列：AbortError未及时catch、仅title锁observer/非canonical路径、仍漏auth首因、最后ECONNRESET。第二/第三8断言、第四10断言只是未完成阶段，既不计通过也不新增发现；ECONNRESET成因未独立定位，不据此声称通用keepalive或生产native crash。最终Connection:close每请求新连接是明确验证边界，不能把最终500/200普遍推广到所有浏览器连接。

maintained isolator建立private HOME/state，脚本入口拒root；各realm在Core/Host导入前exact-origin guard，Host/holder另deny directnet/tls，parent只owned HTTP且不导入Core/Host。脚本确实有自有Node host/holder child，“无agent worker”不等于无子进程。finally对请求即时catch/abort/allSettled、修权限、await owned children/Host关闭、删owned数据，isolator等待fixture close后删HOME。作者post-run receipt记录owned根及isolator根已删除、精确进程检索无残留，不加38；主审JSON的退出收据与源码清理契约一致，未由本审计重新执行ps或文件存在实验。

## 分级、去重与整合

P2范围合理：需要已初始化Hub、有效请求、dataDir失写而hub本身仍可操作的明确存储故障；正常权限与短真实争用均正常。局部非争用错误放大成整个Headless Host约30秒可用性停顿，高于局部无反馈P3；但有界恢复、无破坏/越权，不支持P1。Node22/Electron/Linux/Windows、其他errno、锁前mkdir/chmod已立即失败、整盘EROFS均未动态验证。修复只应为真正可重试争用保留退避，对明确权限/存储错误及时失败；保留跨进程RMW/CAS、认证、symlink及失败不写盘保护。

第十八轮Bun EACCES只是未列正式发现的线索，本轮补真实Node/auth前置/事件循环收据，不能改写成Bun已证明Node或title锁。第十八轮通过的500控制是非普通文件registry、取得锁后strict read拒绝，与此次auth acquisition不同；R74的30秒preload RPC timer也不是同步mutex预算。R70/R71/R60/R65分别是autosave、乐观项目名、删除墓碑、目录读错投影，UI修复不能修共享mutex非争用重试，故不重复编号。

最终正式77=1P1/50P2/26P3；common Bun仍每基线79文件236测试，R19 Bun增量0。本轮standalone原生38另列，没有新Bun wrapper，不能塞入默认30秒collector冒称完成或与Bun expect混算。第十八轮3/8/165和第十七轮helper91仍为各自既有计数；latest-only3/8也独立。QC记录897本地Markdown链接、590源码行号、两产品tracked diff空、errors空及source SHA一致，是主审已有机械收据；本审计没有重跑链接/哈希/产品diff检查。

progress当前状态沿用“本轮3/8/165、无本轮native”的小口径歧义已由root修正，我已读新句：明确第十八轮增量，第十九轮各38 standalone/Bun0。其余作者latest一次、root双基线、独立质量审计0执行口径分层准确。两项小措辞已修，无待决语义问题，不需要重新执行。

**Completed：保留R77/FM19-1/P2；本整合审计新发现0，新增测试/原生/网络实验执行0。**
