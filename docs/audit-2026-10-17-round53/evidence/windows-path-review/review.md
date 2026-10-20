# Prep113：Windows工具路径摘要的独立定向复核

**支持同一线索的有限P3静态提案；不另建ID或重复计数。** Root拟正式TUI-R53-02，仅作父任务上下文。已知具体问题后独立读源，不称盲审；没有读取Root111可变包，没有执行Windows、helper、TTY、测试或产品。

## 正常合同与实际显示

`README.md:20`声明macOS/Windows/Linux平台；`.github/workflows/release.yml:151–152`含windows-2022/artifact windows。后者是**Desktop发布matrix，不能单独当作CLI Windows运行验收**。本次只用作仓库声明支持背景，不认证完整平台/终端。

普通绝对路径输入来自Core Read合同：`packages/core/src/tool-system/builtin/read.ts:8`导入node:path，27–35要求file_path为absolute string，51–54接收原值并用本机isAbsolute/resolve选择路径。没有POSIX-only输入限制；没有读取权限/FS执行实现或真实文件。正常Windows本机C盘绝对路径因此不是任意坏DTO。

toolDisplay.ts15–24声明path keys在显示前按process.cwd去前缀，路径在cwd外/已相对者不改；20/51–54包含file_path及Read/Write/Edit。26–27却先要求字符串以`/`开头，正常匹配当前cwd的`C:\...`在读取cwd、sep和共同前缀前就返回原值。这里审的是同一实际process.cwd与同大小写、正常分隔符的本机路径，不借不同cwd、大小写或无效路径造问题。

实际TUI `ToolCall.tsx:42–43/54–56`把args传formatToolArgs并显示argsStr；headless `cli/output/renderer.ts:57–60`对tool_use_start作同样格式化并输出。Core84–98将path交给上述函数后按60字符上限截断，114–115只保留前59字符加省略号。

人工作源码推导：当正常ASCII项目cwd共同前缀已至少60字符，两个短相对文件`src\a.ts`、`src\b.ts`的绝对路径摘要均只剩共同cwd前部，文件区别完全未进入摘要；按原去前缀合同应能显示短相对部分。可用常见多层workspace/project目录构成该条件，无需非法路径、Unicode、超长文件名或超过Windows路径上限。没有调用formatter、构造/运行语言fixture、设置真实cwd或观察终端帧。

影响仅是Windows工具调用摘要中可识别路径/文件名消失，降低区分调用的能力，不声称文件读写失败、权限问题或所有Windows行为错误。建议显示前使用平台感知的绝对路径处理；本轮不修产品或编写测试。

## 旧范围、去重与限制

[初pin](initial-pins.json)先于body/nav：toolDisplay209行/6985B，SHA41ba468c68cb9c564e1401d3c5cd310ab60a1e61600966c45166184871e6c000。Root报告冻结524c0827…，reviewer Git0。本题是已知具体问题定向选段，不认定fresh全文或首次覆盖；旧静态/full阅读不重复计数。

[fresh history](history.json)纳冻52排53+，扫描docs/bugs全部MD和递归JSON scalar values（不查keys）：5150=1489MD+3661JSON，2430509 strings/3611347 scalars、169精确archive/_archive，解析0。path192/SHA60/filename364/oldCause88，各cap100保存100/60/100/88。实际仅读9条canonical-hint compact metadata、[1个原R14 source行和6个bounded旧因窗及R14 MD选段](canonical-gate-read.json)，不是151个机器对象或全部窗口语义穷尽。

R14原utils.md9–11的Slice首加载失败、未执行cache/semver/toolDisplay fixture保持原状态，未修路径/重跑/替代验证。:29的UTIL-R14-R1是UTF-16摘要切片与DESKTOP-R12-01旧因关联；本例全ASCII，原因是Windows绝对路径被前置slash guard排除，未重报该Unicode问题。

同一5150库存作[focused补查](focused-history.json)：relativizePath0、slash guard+Windows0；Windows与formatting宽AND42/cap40。[实际只选读4窗](focused-selected.json)，是工具清单/旧重复formatToolArgs简化记录等；Windows词可能与格式词在长MD相距很远，不能当精确同因或0命中即新颖性保证，剩余36保存窗未声称读完。没有建立已读旧材料中的精确同因；Root可据其额外证据统一分类。

## 范围与冻结

[manifest](source-manifest.json)产品 **4 selected / 0 full，87语义行**；两份声明metadata另列3行。产品正文195行、全部正文233行、含导航241；toolDisplay只46语义/117显示，不登记209full。测试正文/声明/执行均0。Read只到schema/path入口，平台与workflow只到声明；不扩native、FS、权限、身份或完整CLI机制。

[消费者pin](consumer-initial-pins.json)/[支持合同pin](support-initial-pins.json)均先于对应body/nav；[导航](producer-navigation.json)/[支持导航](support-navigation.json)与[后捕获摘录](source-excerpts.json)分开，不把摘录当初读snapshot或重复语义。一个额外合并filename inventory的独立退出码/stderr未持久、仅outer exit0已知，见[首次定位限制](first-locator-note.json)；不编造exit2/rawstderr或声称所有子命令0。无观察到的metadata fatal exception或截断，没有产品验证失败或重跑。

[Ending](ending-checks.json)8份源码/声明/指令pin全同，原5150历史集合/bytes无漂移。当前指令同SHA沿用94真实阅读，不重复计产品行。只运行自有metadata/hash/range和rg，产品/helper/import、Windows/native/TTY/React/clock/timer、fixture/tests、network/model/Git执行0；不修产品/改冻件/更新全局coverage，详见[validation](validation.json)与[receipt](reviewer-receipt.json)。
