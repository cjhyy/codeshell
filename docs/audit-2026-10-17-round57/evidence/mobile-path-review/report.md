# Prep137 — 移动静态资源编码路径独立复核

**不建议晋升正式P3；保留Root同一项STATIC-R135-C1候选，不另建第二个ID。** 条件性handler问题有源码依据，但正常产品资源来源尚未建立。Root后续单测结果不能补足这个缺口。本报告是知道假设后的独立源审，没有阅读Root135作者report/manifest或执行其fixture。[分类](classification.json)给出条件与限制。

Root提供固定产品baseline `1ba606416f4fc94c081159bb3fd10e58cd8d87f0`，仅作外部上下文，Git0。[最初pins](initial-pins.json)在指令核hash及每个源的正文/导航前；AGENTS5/CODESHELL217旧实际阅读按同SHA沿用。mobile-static.ts为202行 / 9561B / SHA `78e25110fe1adeac816d218dc858915c85bc77bd731c386b23a8760e92190ce5`。后续 [资源/测试pins](support-initial-pins.json)、[实际入口pins](entry-initial-pins.json)也先于各自阅读。

条件性源链成立：remote-host-manager219–224将原req传给serveMobile；mobileAssetPath27–31剥prefix/query/hash，未解码percent escape；serveMobile134–135将该字面子路径交resolveSafe，后者按文件名查找。因此若实际root内有`assets/icon one.svg`，请求为`/mobile/assets/icon%20one.svg`且是asset fetch，查找的encoded spelling不同，进入404。若Accept是text/html则可能SPA fallback为index；devUrl是另一proxy路径，不泛化为同样404。这里只是条件源推演，没有真实请求或文件操作。

关键不足是普通producer：

- mobileRootDir70–76/114–117明确默认bundled `../mobile`，override注释为tests。不能把手工临时root中的合法文件名直接当成默认产品资源。
- 实际vite.mobile.config设置base `/mobile/`、out/mobile及publicDir `packages/web/app/public`。该 [public库存](public-assets-inventory.json)现有4个文件：sw.js、manifest.webmanifest、icon.svg、offline.html，全部ASCII且不含space/%等编码需求。
- 实际mobile index引用manifest/main，main导入的是web/app/DesktopApp并以`/mobile/`注册SW，非旧mobile/App。所读manifest `./icon.svg`、public SW allowlist及`${base}sw.js`均使用ASCII名字。CSS/旧App/真实DesktopApp只作必要locator，未把其整体读完。
- [208个相关filename库存](source-resource-name-inventory.json)中也无非ASCII或space/%/?/#名字，但范围仅packages/web与mobile源码目录，**不是完整依赖import closure、Vite vendor行为或最终bundle输出**。没有运行build，也不能据此断言产品绝不会产生编码路径。当前仅未证实普通发行资源会触发，不是否认泛型handler可能存在缺口。

Root报告其一次guarded实际serveMobile测试为3pass/0fail/8expect：plain200对照、space文件resolveSafe成功但encoded URL404、missing404，均临时root、Writable sink、无server/socket。这些是**Root提供的外部报告**；我未读/核hash/运行fixture或日志，自己的产品与测试运行仍0。它支持给定文件名时的handler行为，不证明现有产品资源实际触发；若后续建立普通受支持资源producer，条件性P3评价合理。Root会统一记录这一次attempt，独立review不再计一次。

[共享history pins](shared-history-pins.json)与 [path/SHA投影](shared-history-targets.json)沿用Root纳56排57+的5676份机器快照：static31/mobile34命中全保留，cap100。另 [cause投影](cause-history-projection.json)来自66matches/29files，过滤6个上下文只看350字prefix，主要是无关嵌套annotation历史；不自称亲读全部旧因或全史语义穷尽，也未重复million-scalar扫描。headless/control已decode的对照仅由Root给locator，我没有打开或报告它们。[gate decision](gate-decision.json)保留这些角色限制。

[source manifest](source-manifest.json)为 **9 selected / 0 full，168语义行 = 152产品 + 14测试声明 + 2manifest元数据**，累计显示400行；另3个navigation-only源和2个hash-only公共文件。完整202行leaf/40行config显示不等于全部security/transport语义认证；只核普通路径/资源/URL合同。[摘录](source-excerpts.json)在实际显示后捕获。4个既有partial test声明只有prefix/index/plain/missing意图，0运行，不借其支持生产编码资源。

[首诊断](diagnostics.json)保留9c73e6猜测`packages/desktop/public`不存在的rg exit2；随后按config真实publicDir定位，不重试该错误路径。另own metadata生成器4f20c3在语句执行前SyntaxError exit1，[首错误](metadata-first-error.json)和 [原脚本](finalize-metadata.first.py)原样保存，只补一个字典括号后metadata成功，未重跑产品。无source late pin或工具输出截断。

[结束检查](ending-checks.json)16个源码/指令/asset字节pins、两份共享history原件均同，208filename集合也同；不将结束hash或Root机器扫描当新语义阅读。[validation](validation.json)本人产品/helper/import/fixture/test/browser/HTTPserver/network/native/model/UI/Git运行全0。未改产品，未做权限/路径custody/平台操作。独立 [metadata脚本](finalize-metadata.py)、[最后核对](freeze-checks.json)和 [self-excluded receipt](reviewer-receipt.json)冻结本有界候选意见。
