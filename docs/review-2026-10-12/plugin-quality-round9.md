# Agent Plugins 独立质量复核，第九轮

结论：**R51、R52、R53 均成立，保留三项独立 P2。** 现有正式附录对入口、数据变化及限定条件基本准确，没有发现需要撤回或合并的结论。补充一条 R53 的正常恢复路径：再次从原文件夹预览并显式覆盖安装，可以更新内容而不先卸载；但仍留下新的已删除临时更新源，后续“更多 → 更新”继续失败。

本轮只读两个快照的代码与交付材料，没有修改产品或主报告、没有 build、没有真实模型/账号/外部服务。已先读 CODESHELL.md。重点读取主报告 R51–R53、`plugins-round7.md`、最终便携 fixture，以及旧/新快照各自最终日志。已有七项不再重跑；仅对新增恢复边界运行一个隔离 HOME 的目标测试。

## R51 / W18：卸载后安装任务仍阻止同市场重装

**入口与证据成立。** 最终 fixture 从真实 `MarketDetail` 安装 callback，经实际 Main `installPluginForUi` 和 Core installer 安装；再调用真实 `PluginsTab` 的卸载 menu callback，经过确认后使用实际 Main/Core 卸载；检查实际文件目录、实际 `installed_plugins.json` 和新扫描 catalog 均缺失，最后重新挂载 MarketDetail。确认/alert、文件选择和 IPC transport 是 doubles，服务/安装器/文件不是 doubles。并未把直接改 map 或跳过卸载的静态推测当作复现。

`main/marketplace-service.ts:379–385` 的 job map 与 key 是进程内长期状态；`:473–481` 对 `installed` 无条件返回旧 job。`plugins-service.ts:198–208` 卸载调用不会撤销 job；Main 卸载 IPC 只调用它并广播命令变化。没有找到 map 删除或清空的其他路径。`MarketDetail.tsx:164–166` 的 `installed.has(...) || job.status === "installed"` 足以在真实 inventory 为空时继续禁用按钮；`:92–100` 的历史完成投影还会重填 installed map。即使 installed 列表重新加载为空，旧 job 分支仍成立，因此不是 effect 排序偶发的假阳性。

12 秒后成功 job badge 隐藏，只作用于 `PluginInstallJobsPanel` 的显示过滤，不撤销任务，不解除安装按钮，也不使 service 重做安装。失败 job 的 retry 正常是有效反证，但不能修复 retained success：retry 仍调用相同 `installPluginForUi`，继续返回旧 installed job。

**准确范围：** 必须是同一个 Main service 生命周期里，通过 queued marketplace installer 留下成功 job 的 plugin/market key。之前进程安装、当前无对应 job 的插件不应纳入。fresh query-suffixed service module 清空队列后成功重装，足以证明进程内状态阻塞；它不是实际 app restart 测试。可以表述重启 Main 后重新安装可恢复，不应表述永久无法重装或插件文件卸载失败。当前报告已保留这些条件。

**分级：P2 合理。** 支持的卸载→重装流程被实际状态机阻断，且简单刷新/重开详情/等待 badge 消失均无法恢复。它不是单纯标签显示错误。

## R52 / W19：相对路径源更新失败删除旧安装

**入口与磁盘因果成立。** `PluginsTab.tsx:482–484` 的手动 Update item 无须等待 updateAvailable badge；其 callback 调用 install key，经 preload/Main 到 `plugins-service.ts:283–298`。fixture 使用真实有效 marketplace index 和 `./payload` 源，更新提交只让 payload 的 plugin manifest 无效，并未依靠非法 index、路径越界或人工删除旧安装目录触发。

Core `pluginInstaller.ts:264–271` 把相对路径源先投到固定 `local` final path，`:267` 已删除旧 final。manifest projection/normalization 到 `:380–388` 才进行；失败在 `:389–394` 再删这个 final。registry 替换在校验成功后的 `:403–405` 才发生，故旧 registry row 留下指向不存在的路径。`pluginCatalog.ts:117–122` 跳过不存在/不安全路径是正常读取保护，导致重新加载 catalog 不含插件。因果与 fixture 的真实文件/registry/catalog 断言吻合。

fixture 的原始安装直接使用 Core marketplace install，代表在当前 Main 尚无 retained job 的既有安装。这是有效隔离，不是人为避开正常 gate：插件跨进程保留、job map 不保留。它证明 R52 无需 R51 同时存在。

**准确范围与恢复：** 限定市场相对路径源使用恒定 `local` cache path，且 marketplace refresh 成功、随后插件新内容校验失败。不推广为所有 Git 新 SHA cache 或 direct/local atomic update 都删除旧版本。旧 Skill 文件确实消失，新的 catalog 读取不再提供插件；不据此推断所有既有 MCP 子进程/内存 hook 会立即停止。当前 mounted PluginsTab failure path 不 reload，所以 stale row 仍在；新 catalog 与后续 update 却无法找到它。正式报告已明确这些差异。

源修正后刷新并重新安装的控制恢复文件、catalog，且 registry 仅一条；不需要手改注册表。若同一 Main 另有 R51 的 completed job，重装入口可能还受其独立阻塞。这是两缺陷可组合，不是重复。有效 v2 update、无效 direct/local update 保留旧版本两个控制均直接支持收窄范围。

**分级：P2 合理。** 普通手动更新遇到上游无效内容，本应保留的已工作插件被移除，影响后续可用性；不宣称用户原始 source 或任意工作文件丢失，也没有 P1 的未提交工作丢失证据。

## R53 / W20：预览安装把已删除的私有快照记为更新源

**入口与 provenance 因果成立。** fixture 调用真实 PluginsTab “从文件夹”，file chooser double 返回原目录；真实 preview 与 review-dialog 的 onInstall callback 保留原路径和 review token，实际 Main/Core install 成功。不是 fixture 把临时目录当作用户选择传入。`marketplace-service.ts:578–604` 也继续使用该原输入。

`preview.ts:468–483` 为安全审查建立并校验私有 snapshot，只把 snapshotRoot 交给 `installLocalPlugin`；finally 在 `:484–485` 删除 snapshot。`installFromArchive.ts` 的 options 只有 overwrite，没有继续传 durable source；`install.ts:47–55` 最终保存 `options.source ?? sourceDir`，因此写入 snapshotRoot。`update.ts:137–159` 以后按 metadata.source 查找，本地 missing 检查自然失败。原目录仍有效也不会自动被使用。fixture 实际读取 metadata、临时路径缺失、原目录存在，以及 v1 内容/registry 保留；证据与结论吻合。

私有 snapshot 本身是正确的 review/TOCTOU 防线，不是应删除的安全 gate。修复必须保留 immutable reviewed bytes，并单独携带 durable provenance。source 预览后改变会被 `previewChanged` 拒绝的控制是正确契约，不与缺陷冲突。CLI `plugin update [--force]` 使用同一个 updater，不能让坏 provenance 自愈。此目录复现不概括 ZIP 的更新契约。

**恢复补充：** 现有附录正确区分 direct install 与 reviewed GUI install，也正确指出卸载/direct 重装是另一次安装操作；但可以补充更轻的现有 UI 路径：**重新“从文件夹”选择仍存在的原目录 → 重新预览 → 确认覆盖**。`PluginsTab.tsx:232–254` 在 alreadyInstalled 时发起覆盖确认并传 `overwrite: true`；`installFromArchive.ts:73–86` 走 `reinstallAtomic`，无须先卸载。

我用真实 Main preview/installReviewed/update services 与编译 Core installer 独立验证：v1 reviewed install 后 More Update 失败；原目录改成 v2，重新 preview + overwrite 后，同安装路径成功更新到 v2、registry 仍只有一条；新的 metadata.source 又是已删除的私有 snapshot，More Update 仍失败。故“无法通过原更新动作更新”成立；“完全没有办法更新内容”则过宽。主报告当前标题明确指向所记录更新源，没有作后一种绝对化陈述。

**分级：P2 可保留。** 正常公开的 More Update 对有效、仍存在的目录源被确定性阻断。额外手动预览覆盖是可用 workaround，但未恢复其更新契约；不要称插件被删除、旧内容不可用或必须卸载才能恢复。

## 独立性、基线与证据限制

三项独立：R51 是成功 job 生命周期与实际 inventory 脱节；R52 是 marketplace 恒定 cache path 的替换前校验/回滚缺失；R53 是 reviewed content location 与 durable update identity 混淆。R52 不需要 job，R53 原插件仍在且 registry 正常；三处修复互不替代。R28 初次 disabled-list load 竞争、R26 Skill 编辑 revision 不涉及这些状态，不应合并或重复计数。

独立核对 `git diff 84740d56..a66f4ef2`：上述 Core installer/catalog、Main 两服务和 renderer 两组件无变化。正式便携 fixture 的两份完成日志各为 **7 tests / 61 assertions / 0 skip / 0 fail**，与原报告一致。各 fixture 的真实 callback 位于 React hooks/effects harness；不是 Electron end-to-end。报告已承认该边界，没有依赖未做的截图、真实第三方下载或执行插件代码。

新增恢复测试：`/tmp/codeshell-review-20261012-plugin-quality-round9/reviewed-overwrite.test.ts`；日志 `reviewed-overwrite.log`；结构化结果 `recovery-observation.json`。结果 **1 pass / 21 assertions / 0 skip / 0 fail**。使用仓库 guarded runner 的临时真实 HOME，Core-facing imports 前拒绝 fetch/http/https/net/tls JS transport，两个负探针成功且 0 unexpected transports；这是进程内 guard，不是 OS sandbox。没有真实账号、模型、网络 Git 或外部 source。

```sh
node scripts/run-bun-test-shard.mjs --timeout 30000 /tmp/codeshell-review-20261012-plugin-quality-round9/reviewed-overwrite.test.ts
```

建议交付只补充 R53 的重新预览覆盖 workaround，其余三项结论与 P2 独立计数无需调整。

## 主审便携复核

新增正常控制脚本已收录 [`reproductions/quality-round9/`](reproductions/quality-round9/)，仓库相对导入，在两基线分别 guarded 通过；本附录已有缺陷用例的重查不重复累计。CLI控制3测试31断言、reviewed overwrite控制1测试21断言；没有新增发现编号。
