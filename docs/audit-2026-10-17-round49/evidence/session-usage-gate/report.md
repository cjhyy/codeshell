# prep79 TUI session usage 读前门槛

**0 formal / 0 candidate / 0 related；primary hook因sameSHA旧full记录在正文前排除。** 没有新读hook正文、App consumer、client.query DTO或测试，不重新判断session切换、summary刷新、过时结果合同，也不把旧full当成当前无bug证明。

先[实际文件名导航和pin](initial-pins.json)，确认源是packages/tui/src/ui/hooks/useSessionUsage.ts，66行/2357B、SHA58fb678f7d2377d0e162bb99ee2402a3fb76b18315d49a8557c64e4b57fb7b59；没有猜.tsx成功。实际co-listed测试为useSessionUsage.test.tsx，107行/3330B、SHA708f3a95d5aa9fef914aefd65e7ed1f0630b4f01125c8acc5e97633e88bef905，只hash/文件名导航。CODESHELL在71已完整读当前217行，本次同SHA56d9…沿用、AGENTS同SHA沿用，均不双计新语义。dc2b3d4c7b3650e36f27deda6f20c87712a8e684仅Root最后提供的上下文，本reviewer未调用Git。

[Canonical原object](coverage-gate-detail.json)：R7 evidence/tui-source-manifest.json /sources/15明确readScope=full，只有该source path和唯一source SHA，bytes与当前最初pin相等；没有selected/否定/范围限定。这个原始full足以触发停止门槛，不依赖rank、unknown或派生索引作未读证明。/sources/20也有同SHA测试full记录，只作旁证，**不算第二个frontier选择或新增测试阅读**。其余aggregate/source-manifest pin只作metadata，不借old frozen-blob布尔字段冒充本轮Git验证或执行结果。见[分类](classification.json)。

[Fresh history](history.json)使用[本次标准库metadata方法](history-method.py)全量扫描docs/bugs MD文本与递归JSON value scalars（keys不当scalar搜索），纳冻48、排numeric49+（含未来79）。4492=1442MD+3050JSON，1953735strings/2921270scalars、169exact archive/_archive、0parse。hook path/filename21、SHA11，test path/filename18、SHA11全部在cap100内保留；broad cause229/cap100仅保留100。机器计数/搜索不等于语义读尽，派生claims不成为新阅读。

实际只窄读4个[原scope/pin行](old-scope-selected.json)和两个原object，检查readScope/reviewMode/inspectionScope及其它scope别名；没有声称语义读尽100cause窗口、229命中或全历史。因为正文前已排除，本包没有新根因推演、旧bug当前状态判定或客户端行为认证。Root先前App355–361观察不算本reviewer本轮source阅读。

[source manifest](source-manifest.json)的files=[]：产品full/selected/nav body/显示/语义均0，2个文件hash-only、2个文件名导航，测试声明/执行0。旧coverage metadata与产品source分列。没有读取真实配置/用户会话，没有展开权限/identity/store锁机制；产品/helper/import/React/timer/client query/fixture/测试/模型/native/网络/Git执行与产品写入均0，见[validation](validation.json)。所有命令exit0，无metadata首错/工具截断需要隐去；没有重启旧失败方向或借旧tests pass。

[Ending checks](ending-checks.json)：4个产品/指令pins及1份canonical文档全同，4492历史集合无增删、成员字节无漂移。原时点不倒填，不认证未来HEAD。冻结见[receipt](reviewer-receipt.json)。
