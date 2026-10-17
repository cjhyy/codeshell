# Server / 普通数据转换续审

冻结基线 `0f83bbfdfb8f2c6f31148250bd6544f5325c16e7`。产品源码只读；本报告仅记录自有离线数据观察。各实验首跑通过隔离 HOME/config 的 guarded runner，原始 stdout/stderr 首次即重定向保存。

## R3-01 [P3] Codex 正常 file_change 完成事件完全丢失修改文件投影

- 位置：`packages/server/src/mobile-remote/codex-parse.ts:98-107` 只在 item.started 发 Edit，且只读取不存在的单数 `item.path/kind`。
- 契约：本 parser 注释称按 codex-cli 0.142.4 形状适配。已读同版本官方 [SDK types rust-v0.142.4](https://raw.githubusercontent.com/openai/codex/rust-v0.142.4/sdk/typescript/src/items.ts)：file_change 由成功/失败后的完成事件携带 `changes[]`，每项有 path/kind；不是测试作者猜测的协议。
- 触发/预期：正常 item.completed file_change 里有两个文件变更，应在 render-friendly 事件中保留可读文件/结果归属。实际返回 `[]`；即使喂相同数组形状的 started 事件，也只得到空路径 Edit。
- 影响：Codex room 的正常工具/变更卡缺失文件信息。外部实际文件变更没有被逆转；只影响 CodeShell 的事件投影与房间历史，不声称实际写文件失败。
- 证据：`evidence/root-codex-event-data.test.ts` 第一项生产纯 parser；追加独立 `root-codex-room-projection.test.ts` 使用 fake agent 输出协议数据，经真实 parser → RoomManager.send/onAgentEvent → 自有 JSONL → getHistoryPage，持久消息中没有 Edit。两份原始日志分别 **4 pass/9 expect**、**1 pass/7 expect**，均 Completed，后者与 R3-02 共享。
- 边界：fake agent 不启动 CLI、网络或模型，未运行真实 Codex/手机 UI；RoomManager 是当前源码，包依赖复用安装的 dist。
- 查重：10-16/10-17 findings 与旧 review 按 parser/file_change/MCP 关键词有限查重未发现同一已确认项。与上一批 R2-08 外部 changedFiles rename 归属是不同消费者/修复点。

## R3-02 [P3] Codex MCP 结构化成功结果与失败原因变成不可读摘要

- 位置：`packages/server/src/mobile-remote/codex-parse.ts:74-80` 用 String(result)，且失败时不读取 item.error.message。
- 契约：同版本 [官方 SDK types](https://raw.githubusercontent.com/openai/codex/rust-v0.142.4/sdk/typescript/src/items.ts) 的 MCP result 是包含 content 和 structured_content 的对象，失败原因在 error.message；本仓既有测试只用 result="ok" 字符串，未覆盖正常平台形状。
- 触发/预期：正常结果含一条可读 text，应在400字符摘要中保留文字；失败含 error.message 应显示失败原因。实际成功 summary=`[object Object]`，失败 summary=空串且 isError=true。
- 影响：正常工具结果和失败诊断从 CodeShell room 历史中丢失，用户只能看到无意义对象文字或空错误卡；外部 CLI 自身 transcript 未改。
- 证据：纯 parser 第二项和真实本地 RoomManager 投影试验都得到上述 summary，普通 command/text 正常对照保留正文。日志共享计数只计一次，未执行外部 MCP/CLI/真实发送。
- 接线：`codex-room-agent.ts:156-165` 在 stdout line callback 分派 parser 事件；`room-manager.ts:1178-1187` 直接存 summary；Web `lib/messageMappers.ts:59-65` 直接映射为 reducer result。后段 UI 为静态接线，不作为额外动态实验。
- 查重：同 R3-01；成功对象与失败 message 丢失归为同一 MCP 结果投影缺陷，不拆两条增加计数。

## R3-03 [P3] Codex JSONL 的 null 记录没有按噪声隔离

- 位置：`packages/server/src/mobile-remote/codex-parse.ts:30-37` JSON.parse 成功后直接读取 msg.type。
- 触发/预期：本地 CLI stdout 有非对象 JSON 标量 null，应与 malformed JSON/未知类型噪声一样忽略；实际抛 TypeError。没有证据证明正常 Codex writer 会生成 null，所以只按损坏/不符合对象 schema 的记录边界报告。
- 证据：`root-codex-event-data.test.ts` 第三项生产 parser，malformed/unknown 记录正常对照。对应整组4 pass/9 expect/Completed；没有真实进程崩溃实验。
- 影响：parser 调用失败。stdout readline callback `codex-room-agent.ts:156-165` 无局部 catch 是静态可达边界；不声称已实测整个 Host 崩溃。
- 查重：与上一批 R2-04 Claude history 的 null 校验属于相同缺陷家族，但此处是独立的 Codex live JSONL parser/进程消费者和独立修复点。不会再次计上一条已确认位置。

## R3-04 [P3] Windows 格式 cwd 的默认 room name 使用完整路径，长路径生成不可读元数据

- 位置：`packages/server/src/mobile-remote/room-manager.ts:617` 只按 `/` 分割 cwd 派生 name；reader `:96` 要求 name 不超过512，createRoom 的 cwd 则允许32768。
- 触发/预期：不传显式 name、cwd=`C:\work\project-name`，应与 POSIX 对照一样得到最后项目段 project-name。实际 name 为完整 Windows 路径。更长、总567字符且每个普通目录段较短的 Windows 格式 cwd 仍通过 createRoom 参数校验，但派生name超过512。
- 实际/影响：长格式输入写入并返回 room id，紧接着同一个 manager.getRoom 得 undefined、listRooms 不显示、getHistoryPage 报 metadata corrupt；普通 Windows 路径也显示完整cwd而非项目名。显式name和POSIX basename正常。
- 证据：`evidence/root-room-default-name.test.ts` 为真实 RoomManager + 自有临时 room 存储，3 pass /11 expect /0 fail/skip /Completed，首跑原始 log 保存 name长度与readable=false；factory若被启动就抛错，实际未调用agent。
- 条件/边界：运行机器不是 Windows；动态证明的是接受的 Windows 格式字符串与本地metadata读写自相矛盾，没有创建真实Windows长路径、启动真实CLI或验证Windows操作系统的长路径设置。因此保守按P3条件项，不把它扩大成所有Windows会话打不开。
- 查重：当前两批 audit及旧review对room默认Windows name关键词有限查重未见同项；与旧room进程退出/approval/接管问题不同。

## 覆盖与既有基线

- 选择性阅读 Server room-history、room-manager（metadata/seq/history/agent事件等段）、session-titles-store、HubRunReplay、model-trace-history/http 结构及 Mobile history/事件投影接线。认证/权限方向不做动态验证。
- `evidence/root-codex-parser-baseline.log`：当前既有 parser suite 仅排除 approval_request 方向，**15 pass / 1 filtered / 24 expect / Completed（runner16 selected/1 skipped）**。该 suite 的 file_change/MCP mock 形状与官方协议不一致，不能用其绿色结果反驳新正常形状证据。
- `evidence/root-history-replay-baseline.log`：选择性普通磁盘历史冻结/跨冷重建、since过滤、snapshot过期/较大普通分页；内存run replay前缀/重叠/预算/复制；会话title并发串行与严格写/比较。**14 pass/9 filtered/59 expect/Completed（runner23 selected/9 skipped）**。其中既有10,010次本地fsync准备的测试显式120秒timeout，首跑约40.7秒完成，不作为独立性能bug；没有重跑。没有执行scope认证、权限/替换文件或真实worker测试。
- 所有新发现区分真实 parser/本地磁盘和外部平台；没有构建、真实模型/账户/外部服务/进程执行。

## 候选与跳过

- Mobile buildSessionHistory 会丢 FoldItem 的 injected/clientMessageId/timestamp 等字段；其附件/内部路径投影已有旧 `docs/review-2026-10-12/legacy-history-round24.md` R84 详细确认。本轮只读核对该已知家族，没有另做附件复现或重复计入。额外internal anchor为空白气泡的影响尚未独立动态验证，继续仅作相关候选。
- 辅助只读检索带入不存在的 shared/transcript.ts、web/src/streamReducer.ts、renderer/messages/types.ts，rg报ENOENT。它们不属于运行实验，也不作产品问题证据；未重跑失败动态 fixture。
- ModelTraceStore 普通summary/search/分类/排序/paging/retention链路作选择性静态阅读；list和sessions当前都复用localeCompare做cursor后继，没有把旧catalog comparator问题套用到这里。搜索是metadata字段而非JSON正文，不将Pet全文预筛问题误报到此模块。未增加动态测试或确认项。不存在的model-traces/capture.ts辅助读取已跳过。

本分审5个完整成功首次shard共 **37 pass /110 expect /10 filtered /0 fail**。实际新缺陷观察/正常对照共8个测试，其余29个为当前选择性既有基线；没有把filtered选中数量当作已执行测试。
