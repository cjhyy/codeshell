# prep77 agent definitions 读前门槛

**0 formal / 0 candidate / 0 related；两项sameSHA旧完整静态阅读在正文前排除。** registry primary和definition fallback均未打开产品正文，不把本次字段识别或旧阅读再算成新增源码覆盖，也不对所有definition行为作正确性结论。71冻件和旧索引均未修改。

[最初pins](initial-pins.json)：registry124行/4696B，SHA89968b313f8da865dadc6fe6bb85dc61182fd5ff4795aebd22c9505c4e10f072；definition147行/6078B，SHA69c6006acd4ebac512b59e25536f4f2b892e60475a13fa0971728911e0f95013。CODESHELL在前一71已完整读当前217行，本次同SHA56d9…沿用；AGENTS同SHA沿用，均只重复hash。本reviewer Git0，dc2b3d4c7b3650e36f27deda6f20c87712a8e684仅Root最后提供的外部上下文。

决定性证据是[两份原object](old-reviewmode-objects.json)，来自同一个R6 evidence/skills-source-manifest.json：/files/4 definition和/files/5 registry均明确reviewMode=complete；每行只有一个source path和一个唯一64位source SHA（sha256/frozenSha256值相同），bytes/lines均与当前最初pin相同。不是从旧44 inventory的unknown标签反推未读。

对complete也做了限定核对，见[scope context](coverage-gate-detail.json)：该manifest把complete、caller-contract-or-selected-excerpts、complete in-scope local-discovery/cache/metadata branches…分开；本两行没有附带选段/部分/排除范围。R6 skills-agents.md53明文说明“Review modes distinguish complete primary modules from selected caller/contract excerpts.”；11列出definition serializer、registry deterministic recursion/merge/disabled filter、实际Agent和Desktop list契约。文中代码行号是合同锚点，没有把这两行complete改成“只读这些范围”。49排除安装/权限/安全/runtime方向，是运行/机制边界，不扩成这些机制已认证，也不否定原主模块静态阅读标签。因此按[gate decisions](gate-decisions.json)停止本次产品正文。

旧报告3/21–23/36–43保留原首fixture依赖失败及S-C2 CRLF候选SKIP边界。本次只读旧metadata，不运行fixture、registry、parser、子代理或模型，不修/重试该失败方向，不借旧部分pass，不变更其dated分类，也不宣称当前已修/未修或生成新ID/related。

[Fresh history](history.json)纳冻48、排numeric49+（含本未来77），全docs/bugs MD文本与递归JSON value scalars参与机器搜索，keys不当scalar搜索。4492=1442MD+3050JSON、1953735strings/2921270scalars、169exact archive/_archive、0parse。registry path99/SHA12全部保留；registry filename140/cap100、definition path113/cap100、definition filename154/cap100只保留100；definitionSHA17全部保留；broad cause1054/cap100保留100。机器计数和派生claims不变成新语义证据，cap也不表示读尽。

实际只在41个精确path/SHA对象中窄读上述2个canonical object、旧报告1–53以及相关限定，不声称语义读尽1054cause命中、100个保留窗口或全历史。初筛scope/coverage/review/readScope/inspectionScope白名单漏了reviewMode，返回[0行的首件](old-scope-selected.json)保留；这个0不是未读证据，随后查原object纠正。首次较宽MD显示714f9d发生工具截断、exit0，原tool输出留在会话，完整原history-contexts未改；没有虚构未截断完整日志。两项都记在[metadata notes](metadata-notes.json)，不作产品失败或重试。

[source manifest](source-manifest.json)的files=[]：新产品full/selected/nav body/显示/语义均0；2个产品hash-only、6个文件名导航（含4测试名），测试声明/执行0。旧report53行是审查metadata，和产品source覆盖分列。未读取真实配置/用户会话，未审或操作权限、credential、tool execution、锁、native、子代理机制；产品/helper/fixture/test/模型/网络/Git运行、产品写入均0，见[validation](validation.json)。不自动把reviewMode扩到其它文档，不改旧index或classifier。

[Ending](ending-checks.json)的4个产品/指令pins、2份canonical metadata文档全同；4492历史集合无增删、成员字节无漂移。原时点不倒写，不认证未来HEAD。冻结见[receipt](reviewer-receipt.json)。
