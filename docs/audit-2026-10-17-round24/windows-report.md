# Windows NSIS 验收合同深静态审查

冻结点 `c9056c8047a8e75ab2469e59bf1d3fedd9ad7272`，本方向 **0 新确认、0 新候选、0 新关联项**。指定五份源码 **2041 行全部静态阅读**；产品/测试/import/constructor/PowerShell/installer/process/native/模型/网络尝试均为 **0**。没有新增或运行 fixture，也没有更改产品或 Git。本文的正常控制与失败判断均为源码推导，不是本轮执行通过。

完整范围为 driver 787 行、driver tests 256 行、finite acceptance helper 383 行、helper tests 506 行、observer 109 行。[source manifest](evidence/windows-source-manifest.json)另列 inventory/integrity 的 101 行全文及 build receipt、local build config、UI step/final、workflow 和历史范围的 selected 阅读，共 11 个冻结/当前字节 pin。没有把选读的包装器、watchdog、平台 API 或历史大段记录当作完整运行图或全模块语义覆盖。

## 普通合同、阶段及反证

| 范围 | 当前普通成功条件及失败接线 | 静态边界 |
| --- | --- | --- |
| 启动与包来源 | [hosted gate](../../packages/desktop/scripts/windows-nsis-acceptance.mjs#L29) 先于 driver 产品观察；真实 checkout HEAD/clean state 与 build receipt 平台、架构、来源、关闭发布/身份配置相匹配 | 环境值是明确的 launch refusal policy，不能证明 VM 的密码学身份或 OS 隔离 |
| 安装前状态 | [preflight](../../packages/desktop/scripts/windows-nsis-acceptance.mjs#L157) 要求完整 registry rows、固定 KnownFolder 路径、无同名 App、所有目标 absent；driver 也拒绝预存安装目录 | 只是固定时刻的状态合同，不推定跨进程不可变或枚举一切 OS descendant |
| 生产构建与 payload | [production config](../../packages/desktop/scripts/windows-nsis-acceptance.mjs#L52) 精确比对 NSIS 配置；localPackageConfiguration 保留原 build.nsis；baseline/staging inventories 与 SHA 对比，只允许已 pin 的 elevate helper | 不声称验证第三方 builder/NSIS 内部实现、签名或真实安装输出 |
| 首次安装 | 原 Setup bytes 复核后 direct argv 调用；[normal process](../../packages/desktop/scripts/windows-nsis-acceptance.mjs#L285) 同时要求 code=0、signal=null、errors=[]、signalRequests=[]、完整 cleaned/zero-remaining settlement 和匹配的 root PID/parent/full birth | cleanup 或 wrapper/controller exit 不能单独成为 installer 正常通过；测试中的 fake process 仅被阅读 |
| 已安装身份 | [registration](../../packages/desktop/scripts/windows-nsis-acceptance.mjs#L175) 要求精确 keys/values、shortcut target/arguments/appId；[payload](../../packages/desktop/scripts/windows-nsis-acceptance.mjs#L257) 要求原内容加且仅加生成 uninstaller；完整 integrity 与 staged source 相同 | Windows registry view、KnownFolder、shortcut/COM 的真实行为未经本轮执行或外部事实验证 |
| 两轮 UI | [runUi](../../packages/desktop/scripts/smoke-windows-nsis-install.mjs#L622) 先等实际 controller process 合同，再消费子 receipt；[UI predicate](../../packages/desktop/scripts/windows-nsis-acceptance.mjs#L319) 同时验证固定 action list、Main identity/exit、guard、worker count、transport/cleanup ledger、HOME removal、包 bytes | 不能只凭 status=passed、controller 退出或操作数量替代这些条件；本轮没有 UI 或 Main 执行 |
| 同 build 替换 | 首轮 identity/UI 后独占写入 marker；替换前复核登记与 Setup；替换后要求 marker absent、installed identity/payload 完整，并运行第二个 fresh-HOME UI 合同 | 此处只承诺 same-build manual replacement，不是跨版本或用户数据迁移；两个 fresh HOME 是已声明范围 |
| 卸载与 cache | [uninstall](../../packages/desktop/scripts/smoke-windows-nsis-install.mjs#L677) 复核 installed state、pin 并复制确切 uninstaller 后调用固定 `_?=` tail；要求 installation absent、keys/shortcuts 回到初始；[cache contract](../../packages/desktop/scripts/windows-nsis-acceptance.mjs#L270) 独立要求 absent-before、sole installer.exe 和原 Setup hash | 留存 cache 与卸载成功是分开验证的阶段；没有从“卸载 keys gone”直接推断 cache 已移除 |
| 失败及最终判定 | [at/checkpoint](../../packages/desktop/scripts/smoke-windows-nsis-install.mjs#L357) 在阶段前后检查 recording failures；首次失败先同步记账，不继续后续安装/删除补偿；[final integrity](../../packages/desktop/scripts/smoke-windows-nsis-install.mjs#L744) 再检查原包/staging/Setup/process 状态，之后才 status=passed；finally 发现 recording failure 则失败 | controller exit 缓存字段不是 Main normal exit 或 OS liveness；workflow 原生 step 另有 `set -euo pipefail`，不能只截取 JSON 的 status 字段 |

observer 全文中 registry 使用 `OpenSubKey(..., false)` / `GetValue`，路径检查与已存在 shortcut 的 property 读取，以及固定 `Get-CimInstance` 查询；没有源码中的 installer 调用、SetValue/CreateSubKey/Save/delete。这里仅核对观察者源代码的输入/输出形状与 helper 消费接线；没有执行 PowerShell、COM、registry、进程查询或证实所有平台 API 副作用。源码关于共享 registry views 的注释不在本轮当作已独立验证的 Windows 事实。

## 未升级的判断与历史排除

子 UI 的 action rows 没有单独 status 字段，不能据此直接报“接受失败操作”：真实 [step producer](../../packages/desktop/scripts/e2e-ui-packaged.mjs#L94) 在 `await run()` 成功后才 push，final receipt 将 result errors 编码到状态，失败还会 throw。父 driver 同时要求 controller 正常完成及具体 Main/transport/bytes 条件。因此没有普通可达的失败 row 被接受证据，也没有构造坏 receipt、恶意输入或模拟 attack。

driver 在 [process exit](../../packages/desktop/scripts/smoke-windows-nsis-install.mjs#L389) 追加 controller 缓存证据；此时若 save 失败，会设置非零退出码。单独读取之前磁盘 status 不能成为整条验收成功合同；当前真实 workflow 的 pipefail 是必要反证。本批没有刻意制造磁盘失败或提前退出，未据此新增候选。也没有把固定 cap、保留未知 owned state、缺少补偿清理或明确未覆盖的签名/GUI Finish/Updater/迁移范围本身判为 bug。

[近期 prior 记录](../todo/release-real-operations-2026-10-16.md#L315)明确区分旧 directory package 83/12 与新增 NSIS install/replace/uninstall；同时记录 22 个合同测试及其限制。本轮只把这些作为已有合同/范围，未读取或复核其外部 raw/CI receipt，**不把他批成功、失败或验收数字套成本轮测试**。旧插件 reinstall、interval/flow failure、basename process 等历史关键词不等于本文件的新普通安装缺陷；安全/权限/进程 authority 的实验均未恢复。

[历史扫描](evidence/windows-dedup.json)递归覆盖 docs/bugs 的 MD 与 JSON 全标量，含 archive/_archive，排除本批。读取时 **2375 文件 = 1223 MD + 1152 JSON，370703 string leaves / 523455 scalar leaves，0 parse errors**。exact 7 次、mechanism 44 次均保存全部上下文。mechanism 的大小写不敏感 NSIS 会误中 coNSIStency / incoNSIStent，已在[人工决定](evidence/windows-dedup-decisions.json)中排除；不能拿少量 exact 命中或零旧问题条目证明语义新颖/穷尽。

本轮无产品 raw/exit、guarded shard、test pass 或 OS 运行声明；[validation](evidence/windows-validation.json)所有执行计数为 0。[合同清单](evidence/windows-contract-review.json)、[selected history](evidence/windows-selected-history.json)和[作者收据](evidence/windows-author-receipt.json)保留静态依据及 hash。未运行 build/lint/typecheck/full suite，也未以静态结论宣布完整 Windows 安装验收通过。
