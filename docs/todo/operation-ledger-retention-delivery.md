# Operation 账本有界保留交付

本增量让已封存回执退出 16 MiB／10,000 条 active 文件，旧 intent 仍不可重放。
实现、受控验收、合并与正式发行分别记录；没有操作真实用户账本、provider 账号或生产服务。
它不新增 UI、清空历史、轮换幂等 key，或把 unknown 改成成功。
POSIX 主机校验私有目录／文件 mode；Windows 的合成 mode 不是 ACL 证据，保留原私有用户
profile custody，以及 regular／no-symlink／单 link／有界读取与 HMAC，不声称已经审计 Windows ACL。

## 数据与容量

原 `.operations/ledger.json` 仍使用原目录互斥锁、Host cipher 和 keyed HMAC namespace。
schema 1 只在真实写入需要压缩时变成 schema 2；只读查看、重复 prepare、冷恢复查询不迁移。
schema 2 的 active records／observations 保留原上限。新的认证 manifest 按 intent HMAC 前两位
直接定位至 256 个桶，每桶最多 1,024 条／2 MiB。桶名包含内容 HMAC，每个版本不可变。
manifest 的 HMAC 绑定 prefix、digest、count、bytes 和 recoveryBytes。

仅以下完整回执可归档，而且该 ID 不能有任何 observation 或人工决定：

- verified，具有原 attemptId、reference 和 verifiedAt；
- blocked，且从未分配 attemptId。

完整 receipt 原样保留。running、unknown、succeeded、failed、已发送的 blocked 与人工处理记录
仍在 active；其 Run／Session 写入阻断不变。归档 intent 的 claim 永不发送，迟到回调只允许同
attempt 的 verified／succeeded 幂等读取既有 verified，不允许重开或降级。

总元数据容量是有限的：active 10,000 条／16 MiB，加最多 262,144 条／512 MiB 冷元数据。
达到桶或 active 上限而没有安全候选时拒绝新写，不删除旧幂等身份。按当前闭集 receipt schema，
有效 1,024 条的实际容量夹具桶小于 2 MiB；2 MiB 是强制上限，不把较小的实测桶冒称满字节桶。

恢复正文不 prune。每个合法 ID 的两个物理加密槽都认证和计数，包括 checkpoint 未引用的 orphan；
原引用不得缺失。冷 recovery 汇总上限 512 MiB，与 manifest 绑定。单正文仍最多 512 KiB，包络
最多 704 KiB；active 最多 10,000 个 ID、每 ID 两槽，合法 active 包络的理论上限约 13.43 GiB。
冷／active 正文、冷元数据和 active 文件合计有上述显式有限边界，另有小数量 staging／旧版本。
这不是对任意手工添加目录的全盘磁盘配额；不在锁内遍历所有历史正文。整体一致的备份必须包含
ledger、archives 与 recovery，不能只恢复 manifest 或移除 sidecars 后当作完整历史。

## 提交、查询与清理

同一原锁内先认证当前 manifest，再执行目标前缀查询、stage 新桶并原子 rename，最后原子提交
ledger manifest。新桶发布引用前有有界 regular-file 回读。原 key 保持不变；ledger 缺失但已有
cold／recovery／stage artifact 时闭锁，不能生成新 namespace。旧 schema 1 reader 拒绝 schema 2，
不提供降级为可发送空账本的迁移。

每次目标 lookup 完整验证受影响前缀的 HMAC、严格 schema、canonical JSON、排序、身份、容量和
recovery summary；其余所有 manifest 引用桶只做 regular／私有权限／精确大小元数据核对。
不声称每次重读验证全部 512 MiB 历史。目标桶缺失、损坏、错 key／prefix 时 prepare、claim、
review、恢复和迟到 settle 均闭锁，不能把坏桶解释为 intent 不存在。

权限位检查只在 POSIX 执行。Windows 沿用 ledger／credentials 的 Host storage ACL 继承策略，
不会把 `mkdir(0700)`／`write(0600)` 或 `stat.mode` 当作已验证的 ACL，也不新增 ACL 修复或隔离承诺。
[Node 文件模式说明](https://nodejs.org/download/release/latest-jod/docs/api/fs.html#file-modes)
明确 Windows 不实现 owner／group／others 的权限区别。所有平台仍检查真实目录、regular file、
非符号链接／junction、单链接文件、大小及打开前后的设备／inode 身份，读取失败继续闭锁。

下次真实写入才 GC，不从只读路径 GC。最多接受两个 unreferenced immutable 版本、两个 bucket
stage 和两个 manifest stage。每个孤立 immutable 版本先完整认证；同前缀 current bucket 必须
原样覆盖其 receipt。active 的证明使用本次事务修改前的 durable 深快照：除原样覆盖外，仅接受
原 succeeded 与未发布 verified 具有完全相同 immutable 身份、attempt、reference、recovery、
owner、incarnation 和创建时间，且新 verifiedAt 等于其 updatedAt 的情况。全部证明完成后才删除。
未发布的 state、error、更新时间和 verifiedAt 从不写回 durable receipt；允许丢弃证明不等于
采用该证明。缺失、不同 key、未覆盖的身份差异均不删除证据、不提交。这样旧 manifest 单独回退
不能悄悄删掉后来有效的 dedup 证据。
stage 是尚未发布的有界中间文件；异常条目、过多 orphan 或无法证明覆盖时需外部一致性修复，
不会为了恢复可写而自动放宽上限或清空目录。
例如 succeeded→verified 的新桶已写成但 manifest 前死亡，冷读取仍只返回原 succeeded。
真实 finalization 可清理上述严格覆盖的孤立副本并将原 receipt 封为 unknown，保留原 attempt、
reference、恢复引用和阻断；再次执行原 intent 或同 Session 新 intent 均不重发。新 reference、
既有 verifiedAt／人工决定或其它身份差异仍拒绝并保留证据。planned→blocked 的差异也继续拒绝：
它与已提交 blocked 后 manifest 被回退无法区分，自动丢弃可能重新打开已阻止的 intent。
这些剩余情况需要外部一致性修复，不能称所有崩溃均自动恢复。

恢复正文的 atomic writer 在 rename 前死亡可留下 `<digest>.json.<pid>.<uuid>.tmp`。仅真实
锁内写入清理严格匹配该命名、私有 regular file、单链接且不超 704 KiB 的 staging（最多两个）；
先验证目录身份和全部条目，再删除 staging。只读不清理，未知条目／读取或身份检查错误均闭锁，
不会当作缺失或删除。已完成但未引用的 canonical 加密槽永不提升成 recovery 引用或被此清理删除，
仍占两槽和总容量。

压缩每次最多推进一个前缀、32 条。先用已认证 count／canonical bytes 和保守新增 summary 预留
排除无容量桶，再读取一个候选；不能逐个完整重读 256 个桶。一次 prepare 可以先读目标前缀、
再读不同压缩前缀；有两个可清理旧版本时还可能读它们及两个 current prefix，另加新文件回读，
本矩阵最坏七次桶内容读取。review 最多 50 条，可能验证多个目标前缀，不能套用单 ID 的读数。
每次最多认证 32 个新候选的两个 recovery 槽；GC 不逐条重扫历史 recovery 正文。
内容读上界为七个 2 MiB 桶，加 active 的 16 MiB 有界读取；另有最多 32 个新候选和一个目标
的两槽正文检查（每槽 704 KiB）、新桶最多 2 MiB 及 manifest 最多 16 MiB 的写入。
active parse／clone／serialize 与 canonical 校验同样在锁内，不能只把磁盘读数当作总成本。

保留原 file-mutex 的 10 秒 stale 和等待配置，没有网络、审批或异步 await 在锁内。
原子 rename 提供进程崩溃边界，不承诺断电 fsync durability。复制完整历史到两处同时作为实时
账本、任意同用户改文件或整体回退所有证据均不在合同内；HMAC 不是同用户代码的 OS 安全边界。

## 受控验收

`bun run test:operation-retention` 串行运行实际 Node >=22.16 编译后 Ledger／Controller 矩阵和实际
SDK Engine Link 消费者。依赖包 gate 先完成，再读取 dist。每个实际 Node child 使用 fresh real
HOME／USERPROFILE／appstate，去继承凭据；首次 Core import 前安装 exact owned HTTP origin guard，
完成 fetch／http／https 三个拒绝探针并记录 PID／PPID／HOME hash。模型只是确切本地 fixture；
JS HTTP guard 不声称覆盖任意 raw net、所有后代程序或 OS 网络沙箱。

验收包含：真实 Controller 的单 POST 与独立 GET、10,000 条容量迁移、冷旧 intent 零 HTTP、原
schema 1 Git blob 的实际 reader 拒绝、八进程 claim 只发送一次；stage 写完／桶 rename 后／manifest
rename 前／后四处实际 SIGKILL 与冷恢复；另有两个 settle 桶提交点、两个 recovery rename 点，
以及真实 HTTP Controller 最终 verification 的 SIGKILL：未发布 proof 不采用，原身份／阻断保留，
零追加 HTTP。partial manifest 回退零 HTTP且证据不删；真实 Session
owner／review／observations／incarnation 与 Run 阻断。容量 metadata 明确是受控合成数据，不把
262,144 条记录声称为真实 provider 动作。

最大矩阵另覆盖 256 个满 count 桶、接近 16 MiB active、八进程竞争、255 个 2 MiB metadata-only
负向桶的跳过与 affected noncanonical lookup 拒绝、GC＋不同目标／压缩前缀＋新文件回读，以及
实际写满 512 MiB 的加密 recovery 包络（含两槽、非稀疏）和下一正文拒绝。具体实际计数、锁内
耗时、原失败日志与最终源码 hashes 保存于独立验收 receipt；合并和发行以最终 PR／release 为准。

SDK Engine 验收还要求已 verified 原操作归档后不重发，另一个 unknown 操作保持 active，磁盘
终态和 transcript 仍为 unverified_write，冷新 Run 仍零重发。本测试不替代真实 provider 写入、
真实账号或付费模型验收。

每次最终组合验收生成 `native-receipt.json`，记录实际 Node 路径／hash／版本、父子 PID、
容量矩阵字节、七次桶内容读取、所有 SIGKILL 边界与锁内耗时。崩溃后等待原 10 秒 stale 的时间
不算锁内耗时；guard 保持单次锁内小于 5 秒，不放宽原 stale。实际恢复正文矩阵为
536,870,912 B／768 槽／384 ID，无稀疏文件或正文删除。旧源码验收日志中的
`repairRequired:true` 仅描述修复前的 verification 提交窗口，最终组合要求该安全覆盖窗口可恢复。
实测耗时不代表任意硬件的延迟 SLA。

默认 smoke 的 evidence 位于隔离 HOME，会随 wrapper 清理。需要保留原始 receipt／child 日志时，
给 `scripts/smoke-operation-retention.mjs` 显式传入由本次验收拥有的 evidence 目录；汇总也输出到 stdout。

以下保留作者独立源码 `7c2c7e54` 的验收记录，描述修复前 verification 窗口，
不作为本轮两项恢复修复后的最终结论。该矩阵实际 Node v22.16.0，PID 243／PPID 225；canonical active 16,776,392 B，
实际文件 16,776,704 B。七次桶内容读共 8,992,432 B；full count、byte-full metadata、GC＋lookup＋
retain＋readback 三路径锁内分别为 198.022／190.691／363.878 ms。父及竞争子进程全部锁内
最大 1,253.695 ms；崩溃后等待原 10 秒 stale 的时间不算锁内耗时。两组八进程竞争、四个一般
崩溃点和一个 verified 未提交需修复点均终态通过。实际恢复正文 536,870,912 B／768 槽／384 ID，
无稀疏文件或正文删除。此实测不代表任意硬件的延迟 SLA。

初版 `235b4245` 的真实 Windows CI 有 112 pass／3 fail：新增 POSIX mode 检查拒绝了
Windows 合成 mode，导致两项恢复用例提前 blocked 与一项压缩失败。原日志和旧 manifest
保持不变。修复仅在 POSIX 主机执行 mode 私有校验，Windows 保留原 profile custody、
regular／单 link／no-symlink／有界 UTF8／HMAC 检查；新平台策略测试也注册至真实 Windows
shard。修复后新 package、工作区 types、相关测试及实际编译 Node／SDK 矩阵已重新验收；
真实 Windows 与完整组合 CI 以最终 head 的 PR checks 为准。
