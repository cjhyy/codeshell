# Windows NSIS 方向独立静态交叉复核

冻结点 `c9056c8047a8e75ab2469e59bf1d3fedd9ad7272`。已读 windows-report、contract-review、validation、manifest、作者收据、metadata notes与去重决定。结论：**未发现需修订或升级的计数/证据问题，保留0 formal / 0 candidate / 0 related与0产品/测试尝试。** 本review只新增此文件，没有修改作者材料或Git，也没有产品import、测试、PowerShell、installer/uninstaller、UI、进程/native、auth/authority、registry/COM、真实HOME或网络执行。

独立元数据检查：作者指定五份全文范围的行数为 **787+256+383+506+109=2,041**；另有inventory/integrity 101行full，五份额外selected，共 **11个pin**。逐个当前字节、冻结Git blob、SHA、bytes、lineCount及selected上界全部匹配。**14个作者artifact bytes/hash**与 **22个报告本地链接/行锚点**均通过；findings/candidates/related三个实际wrapper均为空。validation runs=[]、rawLogs=[]、guardedRuns=0，所有执行/pass/expect/PowerShell/installer/process计数为0，没有把静态测试声明或旧验收当本轮通过。

本review全文静态读383行finite acceptance helper和109行observer，独立选读driver285–787、实际UI producer的step/final receipt及workflow相关区间。没有把hash核验冒充自己全文重读作者所有2,041行或传递依赖。检查可支持以下窄合同：

- driver在产品观察前调用hosted gate，并比对实际HEAD、clean状态与原build receipt；helper只声明finite environment refusal，不宣称密码学VM身份或OS sandbox。
- 原包inventory/完整性与staging绑定；build后只允许pin过的elevate helper差异，再固定Setup字节。安装前拒绝既有App/登记/路径；normal process不仅看exit0，还要求无signal/error、完整settlement与root PID/parent/full birth匹配。这些均是代码条件，不是平台操作通过。
- 首次安装后先核registration、installed payload与第一轮UI；随后才独占写marker。替换复核Setup/登记，要求marker消失、payload身份一致，再运行第二轮fresh-HOME UI。顺序与same-build范围在源码一致，未被扩张为跨版本/userdata迁移。
- 卸载前复核installed state，pin并复制确切uninstaller，使用固定tail后要求installation absent与初始keys/shortcuts恢复。cache另有absent-before、sole installer.exe、原Setup SHA和删除前复核；最后只删exact file/空目录并再次preflight。不能把“卸载成功”替代独立cache清理合同。
- final-integrity核原包/staging/Setup、recording ledger与各process状态后才设置passed。catch先同步记录first-error，不继续后续安装/删除补偿；finally的recording失败仍设置failed/非零退出意图。process exit字段明确只是controller缓存，不替代实际Main正常退出或OS liveness。

作者没有把“UI action row没有独立status”直接升级，反证成立：实际 `e2e-ui-packaged.mjs:94–100` 先await action，再push row；444–477行把result.errors转为最终状态并在错误时throw。父driver在读取receipt前要求controller process合同，随后还有固定action list、Main身份/normal exit、guard/worker/transport、HOME removal和包bytes检查。由任意坏receipt或缺少单个row状态，不能推导普通producer已把失败操作当成功；本review也没有构造坏receipt或运行替身。

同理，disk receipt暂存的status不是整个验收合同。driver exit handler在save失败时设置process.exitCode；真实workflow的Windows运行step为直接Node加`set -euo pipefail`，不是只解析JSON status。该接线支持不升级“仅receipt曾为passed即代表整体验收成功”的猜测；不保证任意OS/磁盘故障后的全部收尾均已实测。

observer源码使用readonly OpenSubKey/GetValue、路径metadata、已存在shortcut的property和固定CIM查询，没有源码中的installer/registry写/shortcut Save/delete调用。这里只核源代码形状及helper消费，未从注释推断WOW64共享view、KnownFolder、COM、NSIS或真实平台无副作用，不需要据未验证OS知识增加问题。

历史范围与本review先前独立browser scan的读数一致：**2,375文件，370,703 strings / 523,455 scalars，0 parse error**。Windows exact7/mechanism44全部保存，但大小写不敏感NSIS的consistency/inconsistent噪声已排除，不能证明语义穷尽。prior directory package83/12、新NSIS合同22 Node等数字只作旧范围，没有访问外部/tmp/CI raw或加入本轮结果。无新severity、修复验收、全Windows安装通过或全仓完整覆盖结论。
