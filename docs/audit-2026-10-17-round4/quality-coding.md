# 独立交叉复核：Settings 与 root 日志/CLI

复核者为本轮 Coding 专项 agent。冻结基线 `4ee32f28f78b8315112cca77cfc22b2f2f80ced6`。本次仅阅读报告、fixture、首次原始日志、收据与对应源码，并比对文件哈希；**没有运行测试、实验或重试，没有改产品，也没有改任何被复核的原始日志/fixture**。本文件不增加发现或执行计数。

结论：**没有需要阻止合并审计报告的问题**。Settings 的 2 项（P2 + P3）和 root 的 1 项 P3 均有相符证据；CLI 与 dev-recorder 首次 fixture 失败正确单列，4 个 CLI 静态候选及 1 个 recorder 候选没有被冒充动态确认。

| 条目 | 独立核对与级别判断 | 证据边界 |
| --- | --- | --- |
| SET-01 / P2 | `saveUserSetting` 在 `manager.ts:550` 只读 canonical JSON，而 `resolveConfigPath:1086` 与 loader `:924` 在 JSON 存在时优先选择 JSON。两种 YAML 后缀均观察到只保存一个字段而遮蔽其余 user 层。JSON user/project YAML/user 原子 mutation 控制有效。P2 合理。 | 原 YAML 字节留存、删除生成 JSON 可恢复，报告没有称为原文件物理丢失。动态只运行 manager；`/config set → config_set → updateConfig → saveUserSetting` 在 `core-commands.ts:797`、`server.ts:3498`、`engine.ts:4679` 静态可达，未实测 TUI/Engine。 |
| SET-02 / P3 | `Config:99` 的 `setDottedSetting` 检查 key 路径，`manager.ts:581` / `:550–558` 的单字段写入没有完整 schema 校验。真实 Config 返回成功，下一次真实 manager 加载抛错；原子 writer 在 `:639` 拒写同一非法 shape。两种单字段 writer 共用同根因，合并为一项正确。P3 是保守且适当的级别。 | 触发需要错误类型输入；合法 string 写回能恢复。报告限定 settings 读取失败，没有扩大为真实 app 崩溃或正常偏好值可触发。未知扩展 key 的正常控制证明建议不应简单收紧为禁止扩展字段。 |
| LOG-R4-01 / P3 | `logger.ts:439–445` 对完整 basename 排序，`engine-` 确实在所有 `ui-ink-` 之前；七天双 bucket 的 14 文件例删掉全部 engine，保留含最早日期的 UI。单 bucket 八日控制隔离出跨 bucket 排序根因。写入 bucket 在 `:350–361`，TUI setup 的轮转调用在 `setup.ts:24–25`。P3 合理。 | 直接调用生产维护 helper，自有临时文件，不是 TUI E2E。报告限定诊断历史损失，没有扩大为 transcript/项目文件受损。`keep last 7 days` 是实际启动注释；即使只按 7 文件上限解释，删当天 engine 而保留较旧 UI 的观察仍成立。 |
| CLI 首跑失败 / 4 个候选 | `root-cli-data.first.log` 明确在 fixture 第 13 行赋值 readonly ESM namespace 属性时失败；所有产品模块动态 import 都在后面。0 pass / 1 fail / 1 error / exit 1、无 Completed，与报告一致。 | 没有业务断言执行，4 项不可加入确认数、通过数或动态覆盖。独立 retention fixture 只导入 logger helper，没有调用或绕过失败的 CLI command 组，因此不是对该组换方法重试。 |
| LOG-R4-02 日期候选首跑失败 | `root-recorder-day.first.log` 在第 25 行比较 `/var/...` 与 `/private/var/...` 时失败，实际 `recordSessionStart` 从第 26 行才开始。0 pass / 1 fail / 2 expect / exit 1、无 Completed，与报告一致。 | 只确认源码副本字节相等和输出路径字符串控制失败，不能据此确认跨日写入。测试源的 finally 恢复时钟/env 并删除 owned tmp；没有修 realpath、换支架或重跑，保留候选正确。 |

## 收据一致性

- Settings 首跑两文件分别 **5 pass / 31 expect**、**4 pass / 15 expect**；合计 **9 pass / 46 expect / 0 fail / 0 skip**。两份日志都有 guarded Completed，两个 exit 文件为 0。
- 逐项比对 `settings-receipts.json` 的 **8 个 artifact 哈希**，全部一致；比对 `settings-source-manifest.json` 的 **17 个源码文件**，当前文件及冻结 Git blob 均与收据哈希一致。
- 日志维护首跑 **2 pass / 7 expect / Completed / exit 0**；CLI 失败另列，不加到通过测试总数。
- recorder 日期组首跑 **0 pass / 1 fail / 2 expect / exit 1 / 无 Completed**，独立于 CLI 导入失败；两份失败收据都不能加到成功测试/断言总数。
- Coding 原有 **4 个被收据记录的证据文件哈希**亦保持一致，首跑 raw log 未变化。此哈希检查不计作新测试执行。

## 去重与精度意见

Settings 的 619 文件扫描对当前 YAML/user writer 与非法已知字段行为无匹配，且报告已区分 Desktop R70 的拒写队列恢复。复核另外按 JSON record 读取 `docs/archive/review-2026-05-30/{findings,backlog,backlog_ided,...}.json`：旧 Config 条目是 nested dotted key 覆盖 scalar，当前 SET-02 是**合法字段的值类型未校验**，SET-01 是**成功写入时 YAML 层基底选择错误**，不是同一根因。root 的日志 finding 与既有七文件上限描述也有明确区别。

非阻塞精度建议：SET-01 的“跨重启持续”来自落盘 JSON 及 fresh manager 重新加载的证据，可理解为持久化后果；汇总报告应继续把它写成“新建 manager 仍读到被遮蔽结果，真实 app 重启未执行”，避免把推断换成实际重启测试。其余 severity、行号、计数和候选边界无需调整。

复核未扩大覆盖：真实 Electron/Ink/PTY、TUI/协议/Engine 动态链、跨进程并发、磁盘故障、完整 YAML/migration 组合、完整 Settings/Core/Coding/仓库 suite 仍未运行。迁移 providerKey、未来版本/gap stamp、全部 CLI 线索与 recorder 跨日行为继续留在候选列表，不进入新增确认数。
