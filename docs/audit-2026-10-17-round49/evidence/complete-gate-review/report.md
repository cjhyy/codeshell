# prep77 complete别名门槛独立元数据复核

支持仅这两条canonical记录作为正文前same-SHA old-complete gate，无需因调用方选段或旧fixture失败而一律降为selected。不把结论扩成通用reviewMode规则，不改旧索引，不发布新总体覆盖计数。

R6 skills-source-manifest.json `/files/4`（agent-definition）和`/files/5`（registry）各只有一个直接path和一个唯一source SHA值；sha256/frozenSha256相同。两行reviewMode精确为complete，未附selected/partial/not-read/限定范围。当前只hash两产品：6078B/147行、4696B/124行及SHA全部匹配，正文显示/语义0。77保存的两份raw object与canonical逐字段完全一致。

旧skills-agents.md第53行明确“complete primary modules”与“selected caller/contract excerpts”分开；第11行列出合同锚点，不是only-ranges声明。manifest另有明确caller-contract-or-selected-excerpts及complete in-scope分支变体，不能把这些变体自动提升。第49行保留权限/安装/native/runtime等机制边界，不认证那些机制；它未把两条主模块记录改成仅选段。

旧S-C2第36–43行、首失败第21–23行完全保留：新fixture因yaml位置依赖失败，CRLF/registry实验未执行，两candidate SKIP，部分13pass不是成功gate。本次不修/重试旧方向，不重新认证根因或当前修复状态，不把旧complete等同测试通过。

77终态16个文件/receipt15项bytes和SHA全匹配，集合等于receipt+self；报告11个相对链接均存在。77首scope白名单漏reviewMode的0行原件和宽输出截断notes保持原样；截断原tool transcript本复核未重播，未声称完整stdout另有文件。method/history/大contexts仅opaque hash，未执行作者方法或重扫全历史。

本人78为独立metadata reviewer，不是71/77作者；[checks](checks.json)的files=[]，[manifest](source-manifest.json)分列2个hash-only产品，无新增源码覆盖或正式项。18个读前输入pin与结束哈希相同。产品/helper/import/函数、作者/仓库方法、fixture/test、React/clock/模型/native/network及Git执行0。

本复核自己的首次报告打印误请求44–63而实际53行，IndexError exit1；[首输出](metadata-first-output.txt)和checks阶段说明保留。两canonical对象已输出，report块尚未输出；随后仅改为实际1–53范围读取。这是metadata打印修正，非产品或fixture重试；本复核没有输出截断。冻结见[receipt](reviewer-receipt.json)。
