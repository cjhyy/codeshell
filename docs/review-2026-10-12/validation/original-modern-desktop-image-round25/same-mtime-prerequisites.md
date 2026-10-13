# Round25 分页候选：同 mtime 生产前提的追加静态核查

本追加只读冻结产品树 84740d56 与 a66f4ef2；不提升 finding、不改产品及主报告。父任务最新正式 banner 为 85/250，原 static-preflight 的 R01–R83 是当时去重材料阶段，不是本追加当前计数。新增 fixture、产品 import、模型、worker、网络、Git subprocess 与动态产品验证均为 0。

## 结论

在所读原生会话创建、保存、fork、归档、Desktop catalog import/rebuild、自动化调度、部署备份及云项目卷恢复路径中，没有发现**保证两个会话目录的 `stat(...).mtimeMs` 完全相同**的代码。也没有发现为目录时间做降精度、统一赋值或保留源目录时间的原生会话复制操作。因此，排序/游标比较器不一致继续只是有条件静态候选，尚不能提升为已确认的日常用户缺陷。不能声称 APFS 自然必现，不能把 `Date.now()` 相同或 state 内时间字段相同当作目录 mtime 相同。

## 实际键及必要门禁

精确键是会话**目录** mtime，不是 `state.json` 文件 mtime，更不是 state.startedAt：`packages/server/src/sessions-service.ts:297` 对 `path.join(baseDir, e.name)` 调用 `fs.stat().mtimeMs`。`:304` 以 mtime 降序、`id.localeCompare` 升序排序，`:312–317` 找下一页起点却使用 `entry.id > cursor.id`。`:235–248` cursor 数字按字符串/Number 往返，没有显式取整。

可见漏行至少需要同时满足：

1. 两个以上原生会话目录在读页时具有**数值完全相同**的 mtimeMs；本次没有生产收据证明该前提。
2. 同 mtime 组的实际 ID 在所运行 locale 下，其 `localeCompare` 顺序与 UTF-16 `>` 顺序不同；切点处必须受这种差异影响。只有混合大小写不是充分条件。既未执行 locale，也未执行示例排序。
3. 分页边界落在相关同时间组中。首屏全量容纳该组时，下一页比较器不参与该组恢复。
4. 被跳过项通过 `sessions-service.ts:291–293,343–365` 等目录、安全 ID、parent、origin、ephemeral/pet、cwd、archive 过滤。普通 sidebar 主要接受 desktop/automation 顶层会话。
5. 对应行尚未存在 renderer/持久 catalog。`packages/desktop/src/renderer/app/useAutomationSessionImport.ts:131–165` 会跳过既有 ID，`:178–181` 保存服务返回 cursor；旧索引已有行会遮盖遗漏。原磁盘记录、Hub history 仍在，不能推出数据丢失。

生产上确有混合字符 ID 来源：Desktop 独立自动化在 `packages/desktop/src/main/automation-host.ts:297–304,368–374` 使用 automation Engine，run 不传 sessionId；`packages/core/src/engine/run-session-open.ts:169–179` 进入 create，`packages/core/src/session/session-manager.ts:717` 使用 nanoid(16)，并写入 parentSessionId:null、origin（`:738–740`）。这解决 ID producer 的可达性，**并不解决同 mtime 前提**。当前手工 Desktop/mobile 的小写 ID 来源不应扩大为混合大小写触发证据。

## 生产路径与反证

以下位置均为 primary 路径下源码，latest 同文件字节一致。

| 路径 | 精确源码 | 对目录同 mtime 的结论 |
| --- | --- | --- |
| 原生会话创建 | `packages/core/src/session/session-manager.ts:724,764–781` | state.startedAt 使用 Date.now；另行 mkdir、原子写 state、创建 transcript。没有把 startedAt 赋给目录时间，没有跨会话共同时间值。 |
| 保存/崩溃恢复后首次写 | 同文件 `:1936–1942,1984–2008` | mkdir(recursive)、每个 state 的 lock、独立随机临时文件与 rename；没有 utimes/clone/共同 mtime。proper-lockfile 的 mtime lease 指锁协议，不能当作两个父会话目录的共同时间。 |
| fork 持久化 | 同文件 `:2292–2325` | 新建独立 staging 目录，写新 state 与重序列化 transcript，rename 发布；未复制原目录元数据。内容继承不等于目录时间继承。 |
| 归档/字段更新 | 同文件 `:1158–1159,1580–1604`；`packages/server/src/sessions-service.ts:479` | 归档走 updateSessionState/saveStateAttempt，不是跨会话目录复制。archivedAt 的同值与目录键无必然关系。 |
| Desktop legacy import | `packages/desktop/src/main/session-catalog-store.ts:79–119` | 合并 session index，并写 catalog 的 legacy JSON backup；不是原生 sessions 目录备份/恢复。completedAt 也不赋予原生会话目录。 |
| Desktop 磁盘重建 | `packages/desktop/src/renderer/automation/rebuildFromDisk.ts:1–5,38–69`；hook `:145–181` | 纯映射 DiskSessionMeta 到 summary，再 upsert catalog；没有重写原生 state/transcript/目录时间。 |
| 同时调度 | `packages/core/src/automation/scheduler.ts:1120–1144` | 每 job reentrancy guard；lastRun/startedAt=Date.now 后调用 executor，没有将该时间传作文件系统 mtime。多任务同 tick 不是相同目录时间保证。 |
| 通用部署备份/恢复 | `docs/deployment.md:209–234` | 要求停止服务并保存实际路径。tar 示例 `:223–225`、恢复指导 `:232` 不指定 tar 格式、时间精度或目的文件系统；文档的“一致时间点”是快照一致性要求，不是所有目录 mtime 相同。 |
| 云项目卷备份/恢复 | `packages/server/src/project-runtime/backup.ts:28–32,136–169,324–335,498–507` | helperImage 由管理员提供，只要求有 tar；创建 `-cpf`、恢复 `-xpf`，没有指定 format/时间精度/统一 timestamp。源码不能证明某个实际 helper 会截断时间，更不能证明同一秒存在相关目录。 |

云项目卷 data 确实涵盖 `/data/home/.code-shell`（`packages/server/src/project-runtime/docker-provider.ts:399–407`）。但其实际列表通常走 Hub/Core，Core 的 sort 和 before 均用 localeCompare（`packages/core/src/session/session-manager.ts:2397,2410–2418`），不受这里 Desktop disk reader 的比较器差异影响。不能只凭云卷 tar 存在就连成 Desktop sidebar 的自然触发。

## 搜索边界与支持同时间组的正常代码

静态搜索 core/desktop/server 生产源码及 scripts 的 `utimes/lutimes/futimes/preserveTimestamps/statfs/mtimePrecision` 与 mtime 数学处理，未找到原生会话目录显式设时/量化路径。命中的 `packages/core/src/panel-apps/installer.ts:847` preserveTimestamps 是 panel package 安装；`packages/server/src/panels/resources/references.ts:79,207` 是 panel 资源引用；`packages/server/src/sessions-service.ts:104` 是另一条 summary.updatedAt 投影，都不是 `listDiskSessions` 的目录 key。相关文档没有提供原生 Session 的 FAT/exFAT/APFS/NFS 时间精度或支持条件。上述是检索和已检查路径的边界，不是所有外部存储行为的证明。

`packages/desktop/src/main/pet/pet-state-aggregator.ts:436–447` 明确把 same-mtime newcomers 当作应支持输入，`:462–489` 严格低于 watermark 才停止分页；这支持“目录 mtime 不要求全局唯一”的设计边界，却不是生产创建同 mtime 的 producer。没有从该循环推导新的重复/死循环 finding。

## 双基线只读核对

用 Python 标准库 read_bytes + SHA-256 比较，没有导入产品模块。以下 13 个有关文件在两个冻结树均逐字节相同：server sessions-service、Core session-manager/run-session-open/scheduler/utils-lockfile、Desktop automation-host/session-catalog-store/rebuildFromDisk/pet-state-aggregator/useAutomationSessionImport、server project-runtime backup/docker-provider、docs deployment。额外动态验证 0，正式新增 finding 0。
