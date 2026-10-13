# 第二十轮 launch 前独立只读预审消息归档

本文件由实现代理整理收到的 `/root/automation_flow_review/terminal_owner_audit` 消息。该代理本轮新增执行0，没有启动任何应用/原生进程、没有运行测试或改产品；这里不是其最终原生收据审计，不能将后来的31个assert算给它。

其只读核对生产边界：main/index.ts1349–1379主窗无partition/session，1390–1391明确共享session，1447/1466用defaultSession，1492–1498加载同一dev URL或renderer/index.html，5835–5836正式window:new重用createWindow。guest独立分区不属于主renderer。安装electron.d.ts17510–17515的默认session契约也匹配。

其建议最小owned两个BrowserWindow加载同一owned HTML并直接比较webContents.session===defaultSession，可补same-file/defaultSession窄契约；不能冒称fullApp或推广所有file/HTTPorigin。file origin字符串本身不足证明任意路径共享。

其指出 maintained prepareConfinedElectronFixture生成entry会import产品out/main/index.mjs，必须明确不用它的入口；自建Main在ready前设置privateuserData/sessionData，Node guard与Chromium webRequest分别安装，不装真实preload/产品Main，finally await close后删除isolatedHOME。

其随后只读临时native脚本、在尚未执行时核对：mainEntry明确传自有文件，Main无Core/Host/productpreload导入；Nodechild与utilityProcess拒绝，Chromium仅allowexactownedfile；纯HTMLprojection不是实际hook/ModelPill。没有发现加载产品或启动模型/worker的实质入口。预审建议并已由实现代理采纳：

- 增加direct net.connect/createConnection/tls.connect拒绝及attempt收据。
- 在setPath前记录并检查app.isReady=false；启动后读取actualprivateuserData/sessionData。maintainedPlaywright readiness门的限定在总报告写明。
- 请求记录须非空后才断言仅ownedfile，避免every空真。
- 正常Chromium renderer/helpers不是CodeShell worker；不称没有任何OS子进程。

首次launch失败随后发现Playwright loader entry/whenReady互等；修临时入口注册.then后返回。最终source/log/nativeJSON/cleanup已经root独立读取认可，但预审代理未执行/未核这一最终run。本文件不提升其证据强度，最终native1次31assert与root后续执行分账。

Completed — launch前独立只读预审执行0；本文为消息摘要归档，新增执行0。
