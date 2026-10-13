# 第二十八轮最终整合只读语义 QC

核对时钟：2026-10-12 SG 10:36:32（clock UTC 02:36:32）。结论：当前整合材料未见需要阻止保存检查点的实质矛盾。新增正式发现 0，新增产品 import / fixture / test / native / Git / 模型 / 网络执行 0；仅标准库读文件、JSON、哈希和归档容器字节比较，另写本 /tmp 稿与收据，没有修改产品、任务 docs、fixture 或修复交接原稿。

## 当前、历史与计数

主报告 R01–R86 仍连续，实际表格分级为 1 P1 / 52 P2 / 33 P3；通用两冻结基线仍分别 86 文件 / 251 测试。第28轮各静态/归档/handoff 收据均新增 0，不把 706 文件 / 6286 测试加进专项数，不把作者与 root 重复运行相加。README/flow/progress 中第26/27轮的“当时未验证 blank / 首 send”是历史阶段；第28轮只补 blank Files 的静态正常链，不把过去限定回写成动态通过。主审1715本地链接/1032源码行号的机械QC另账，本稿没有冒称重跑该全量脚本。

## Blank Files 正常链与 R86

blank-files-counterreview-round28.md 的生产接线和结论可保留：App 在开 Panel 时 materialize UI session ID；该 ID 尚未被 Core 持久化，panel hook 的 unknown-session 分支设置 ready=true、root=null、mainRootId=null。实际消费者仍允许 body 挂载，完整 project 独立传给 Files；Files 的 workspaceCwd 为 null，不覆盖 primary.path，使用同一 current primary 的 ID/path 并走 project API。没有“必须先发一条消息才能浏览”下限。

这与 R86 的非 null inherited workspace A 不同：R86 在 current primary B.id 上覆盖 A.path，正确 Main outside gate 拒绝；blank 的 null 回退不发生该错误。本轮不扩大 R86、不重复 R65，也不把 Review 的会话门禁或现有 mock 测试拼装为 Files E2E。正文已明确是静态反证，未运行完整 App / Electron / 新 fixture。846-byte 三 fsRoot 注册封套与219-byte readDir箭头属于不同 span；归档澄清各自 SHA/范围并保留原标签稿，不把不同 SHA 误报产品差异或源码更改。

## 既有基线证据归档

baseline-evidence-round28.md 正确声明：706日志及3份metadata均属于早期84740原基线，本轮只是读取和归档；不是 latest0.9.33全套重跑，也不是修复后验收/真实提供方结果。失败 smoke 与 harness 诊断没有被混入三组最终基线通过。

本稿在 JSON 层将归档 manifest 的706条 file/原log路径/大小/SHA/测试数与独立73ad4e09…收据的706条逐项对齐，0不匹配；141/1428、282/2397、283/2461 相加为706/6286。压缩包容器 SHA 实读为 e83019de…，与 manifest 一致。709成员的原字节逐项核验是主审既有收据证明，本稿没有再打开709成员或重读706份stdout；不把“读取哈希”称为重新执行 guarded runner。

build exact raw gzip 与阅读副本的 SHA 都匹配归档收据；实际字节差仅原第25行一枚 ASCII 尾空格。其他五对原字节相同是既有独立审计范围。canonical 文档已经明确：这些 raw success 标记和命名范围不能独立推出日志未记录的外层退出码、精确当时source revision或新快照兼容性；此前命令状态/基线按原阶段记录保留，不由本次归档重新证明。容器mtime/owner等确定性规范不改变成员日志/metadata字节，也不增加测试数。

## 修复交接建议落实

repair-handoff.md 已准确采用必要收窄：R09 明确服务器上传文件，不扩大为会话/仓库文件；R36 明确生产 WorkerBridgeCore 在原生 Node v25.8.1 的动态证据，完整 Hub 路径是源码衔接、Electron Main退出未验证；R58 的 Session managed worktree/独立engine authority与owner门禁保留；R68 的OPEN慢peer有限队列增长不写成实测OOM/崩溃；R77 的已初始化dataDir权限故障、认证锁先于title mutation、约30秒同process阻塞及短争用正常都保留。

六组可并行、同组不等于同根因、不是52项P2逐项清单、不是已修验收，均在正文明确。R09/R01/R06被提到早期对应批次，R06没有改写成所有原输入已彻底丢失；R35仍首修，R58/R68/R77不再只藏在“其余”。当前canonical SHA为67f276e1eb1fc92f0998b0a36429dec8e82e6dadd4fde11c5436ea5a589df6e8，与round28交接收据一致。独立child对handoff及关键附录的只读审计同样未见实质矛盾，新增执行/修改均0。

## 交付

本稿不提出新问题、升降级、恢复能力或新增验收。建议保存当前 docs-only 检查点，并按用户已授权范围继续到 SG11:00；本次局部QC完成不代表整天review目标提前完成。

[本次哈希/对齐收据](validation/original-integration-quality-round28/independent-integration-quality.receipts.json)。主要依据：[blank反证](/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell/docs/review-2026-10-12/blank-files-counterreview-round28.md)、[旧基线归档说明](/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell/docs/review-2026-10-12/baseline-evidence-round28.md)、[交接建议](/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell/docs/review-2026-10-12/repair-handoff.md)与对应round28 JSON/原件归档。没有应用任何修复补丁或执行产品。

[原字节质量稿](validation/original-integration-quality-round28/independent-integration-quality.raw.md)保留，canonical仅映射此收据链接。主审全局机械QC和后续截止状态以progress/round28-report-audit及最终交付记录为准。
