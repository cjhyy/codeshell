# Independent review: Cron and Room data

审查者 `session_title_round22`，冻结点 `c1d007ed0af1eca9b56b32fabbb0ea2401037ee1`。两方向均支持 **0 新正式、0 新候选、0 新关联**。本独立复核只读作者报告、fixture、raw、exit、manifest/receipt 与相关源码；没有 import、产品/测试执行、SDK/CLI、任务、网络、真实读写、timer 或 Git 写。Room 尚未完成的 receipt 未提前当成缺失失败；收到作者 ready 后才按实际 schema 复核。

Cron 的 fixture 只导入实际零 runtime-import 的 cron-expr 叶子。7 个测试、19 expect，使用支持的五字段语法及固定 UTC 引用；没有 malformed 后缀、invalid/NaN/Infinity、DST、闰日长搜索、Scheduler/interval/timer 或旧 suite 重跑。五个 nextCronTime 调用从返回目标与循环步长可核为一或两分钟内命中，至多六次候选检查；这是源码与输入/输出边界推导，并非 profiler/计时观测。测试是补充控制，不能表示完整 cron 合同、真实消费者或旧 TIME1 修复已验证。

Cron 首次 raw SHA `1cee5cd1b50a32f0e349e1607b5a6eff73bba461d137d4477bfe22d79be678e0` 与 exit、validation 一致；完整日志 7 pass / 0 fail / 19 expect、Completed / 0 skipped，exit0、1 attempt、0 rerun。首次 collector 先保存合并 stdout/stderr，再保存 exit/hash、后输出保存路径；没有覆盖旧证据的路径。当前 cron-expr 与旧 TIME1 报告 frozen `ab8b03f86ad38835939d4125b56bf4513cae7f15` 的 Git blob SHA 均为 `5a5fcfd813afb00e42b32cbaa19f9be68918fed0608a30a33cb494ce7f2c3da0`，独立字节核对通过。这只能支持旧机制源码未变，不是旧 malformed 缺陷动态复验，也不产生新问题或关联计数。

Cron 初始 manifest 将 scheduler 选读上界记为 1300，但实际 EOF/lineCount 是 1299。我提出元数据修订；作者已把范围改为 `[1213,1299]`，notes 保留原 sed 命令上界与实际输出 EOF 的差别，刷新 receipt。修订版 9 个 source pins 的 frozen/current SHA、全部 selected 范围、19 个作者 artifact bytes/hash、10 个报告链接均通过。报告 SHA `effb7e7025be96b82a073dbef8da517a3e53751fae286fc2018ec3b4cd3eae34`；最终作者 receipt SHA `e19299489306dd4f36d7efbdb9e97e39f4a7c9a5b42f2737af2d1ad5aab072ba`。没有 fixture、source 或 raw 改动，没有产品重跑。

Room 的实际 fixture 只导入无 import 的 mobile-history.ts，使用 owned reader 与 JSON 数据。四项普通投影控制检查 session 传参/空值、顺序、stream 原对象及 readonly/interleaving；另两项为 owned deferred 与主动 reject 控制，不能当真实并发会话/磁盘故障。helper 的公开接口和注释、实际 handler 调用、transcript reader 的 user/stream 产出选段能支持这些有限输入形状，但不证明端到端手机恢复、renderer、真实 reader、身份或完整元数据合同。

Room 首次 raw SHA `ef82f0429bdd43e631ccc958dd6b57e138e61d90317be663bcb5ba8e96c1fc0b` 与 exit/validation 一致；日志 6 pass / 0 fail / 13 expect、Completed / 0 skipped，exit0、1 attempt、0 rerun，全部 focused，既有测试通过数 0。collector 用排他创建保存 raw/exit。Codex parser 和含审批的既有 16-case suite 未在 fixture import 中出现，运行尝试为 0；旧 R3 baseline/file_change/MCP/null、R84 附件/正文/元数据投影、旧 Unicode/fallback/mapper 根因都未重跑或升级。源码旧版本注释不是当前安装 CLI producer 合同，作者没有据手写新协议输入宣称新 bug。

Room 完成交付后核对：7 个 source pins（作者声明 4 full / 3 selected）的 frozen/current SHA、selected 范围、23 个作者 artifact bytes/hash 与 23 个报告链接全部通过。这里 hash 核对不代替所有被 pin 文件的语义全文审查。报告 SHA `05ff94ee53aa9560d142a01aa2efba2bf05d41fb86396afb046f8adfe7f404e2`；作者 receipt SHA `eb09861a3f5b5e0eca2192da25045fb0f33687bd9a00cab00e85501718553dd9`。一次 sessions-service.ts 猜测路径的 rg exit2 保留在原 navigation 与 notes；作者未重试该路径，独立已有库存/handler 指向的 transcript-reader 只静态读取，不是产品失败、fixture 修复或失败方向动态恢复。

两组作者 source/receipt 共 16 pins、42 artifact 核验，33 个报告本地链接有效；上述计数属于两份交付，各自保留实际/静态界限，不扩大为全仓审查。历史去重有 capped context 与关键词噪声，不能从次数得出语义穷尽。无需新增测试或扩大执行；最终无阻断项。
