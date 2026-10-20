# Prep108：section-cache门槛与model-cache有限DTO选读

结果 **0新正式 / 0候选 / 0新增关联**。主目标section-cache在正文前保留旧范围冲突，暂缓/有限旧合同排除，**不认定确定同SHA全文**；仅替换一次到model-cache。后者只读普通key/value DTO与真实caller边界，没有建立正常生产路径支持的新反例。

## 版本与历史门槛

[初pin](initial-pins.json)先于正文/行导航：section-cache43行/970B，SHA19c9ee13f2c2a8485e265d5a499a3b5583e545aea6e516d3a891f31a0c72cf27。Root报告524c0827…，本读者Git0。当前CODESHELL/AGENTS同SHA仅核hash，沿用94实际阅读，不增加instruction/product语义行。

[自有fresh历史](history.json)纳冻52、排数字53+，docs/bugs全部MD和递归JSON scalar值（不搜keys）：5150=1489MD+3661JSON，2430509 strings/3611347 scalars，1041471 objects/87132 arrays，0解析错误。section path71/SHA24/filename111/oldCause112；cap100，保存71/24/100/100窗口。看25个compact对象定位后，回到[原JSON对象](canonical-gate.first.json)与[原R5 MD选段](section-original-md-read.json)。数量/保存cap不等于全史语义读完。

R25原proposal `/sources/5`同一行确有readScope=full、readRanges1–43和当前SHA；但同文档ancestor decisions又限定section/cache为source navigation、no finalnewcoverage claim。R5原prompt-source-manifest `/files/5`版本同，原prompt.md46/63明确SectionCache reuse/break/invalidation/empty的旧bounded控制，未直接声明源码全文。保留两种限定，不单凭full字段越过ancestor，也不把旧pass转成本次运行。当前section-cache正文/内容导航0，只列hash-only，不更新旧索引。

[唯一fallback初pin](fallback-initial-pins.json)为model-cache65行/1996B，SHAcbe291bac5c1401864c263b860faacb7c6d1472de6fdb57c08a9f00b38488d02。对原5150成员执行[独立fallback查询](fallback-history-method.py)，没有重新创建库存，原成员/bytes均保持；[结果](model-history.json)path89/SHA12/filename140/oldCause336，cap100保存89/12/100/100。读16个metadata对象定位，再核[R10原canonical行](model-canonical-gate.json)及[原报告选段](model-original-md-read.json)：原/files16 frozen/currentSHA一致，catalog.md7–9已有模型缓存读写/TTL静态与旧baseline，但未形成明确全文措辞。本次是已有合同上的有限选段，不称首次/此前未读。

R10 catalog.md23已因错误engine.ts位置使静态命令失败并关闭cache-refresh调用链方向。该方向继续SKIP；model-pool只出现在filename inventory，没有打开或hash，没有猜engine路径、恢复导航或测试。memoize没有作为第二个fallback重读。

## 普通数据与实际边界

model-cache13–23声明CachedModel和ModelCacheFile：id/contextLength/maxOutputTokens，外层fetchedAt/providerKey/models。27–38普通路径将读得的JSON解析为该DTO，对无models数组的值返回undefined；40–53把收到的providerKey/models放入payload并返回。这里只理解普通key/值/返回投影，不将任意坏JSON、伪造providerKey或磁盘破坏造为正常缺陷。

真实model-fetcher76–85在非refresh路径用opts.cacheDir/provider.key调用readCache，合格cache以spread保留字段并加fromCache:true；123–124用同样key写finalModels并返回所获file。isStale只停在调用边界，provider获取、normalization/catalog/enrichment仅相邻显示或调用边界，没有展开网络/凭据/模型机制。没有从已读正常数据映射建立新反例。

FS exists/read/write/mkdir、Date.now/parse/TTL、defaultCacheDir/userHome和ModelPool.reload均不纳本次机制认证或运行；真实缓存、配置和用户数据未读。目标文件虽整65行显示，只有38行普通数据语义，不能升full。消费者显示44行，仅12语义行。

## 范围与冻结

[manifest](source-manifest.json) **2 selected / 0 full，50产品语义行，109正文显示、含导航126；测试正文/声明/执行0**。primary section-cache43行hash-only另列。已知R10相同版本普通合同旧读保留，必要选段不累计为全史唯一新增覆盖，不作全局coverage更新。

[consumer初pin](consumer-initial-pins.json)先于body/nav；[导航原件](producer-navigation.json)保留可选.models项重复转义的有限性，实际使用的readCache/writeCache/isStale/CachedModel定位有效，不称属性查询穷尽；未为补全而展开ModelPool。无metadata fatal error或输出截断。fallback模板OUT标签在执行前修正为本exact目录，没有外部写入；fallback inventoryExitCode0仅承接原rg成功状态，不假称另跑库存命令，outer元数据解析运行exit0另有实际工具结果。

[显示pin](source-display-pins.json)与[读后摘录](source-excerpts.json)分开，摘录不作预读或重复语义。结束[checks](ending-checks.json)5个源码/指令pin全同，原5150历史集合/bytes无漂移；所有当前可见命令完成exit0。仅运行自有metadata/hash/range方法和rg，不运行产品/helper/import/fixture/tests/network/native/model/Git，不修产品或改冻件，见[validation](validation.json)与[receipt](reviewer-receipt.json)。
