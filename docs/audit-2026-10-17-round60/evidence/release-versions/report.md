# 发布版本一致性有限静态审查

新增 **0 formal / 0 candidate / 0 related**。Root 给定基线 `c6a85ac1b69329f35bc1f6ff34d08070f91b1d96`；本代理未运行 Git 或发布校验，不认证实际发布结果。

实际读取 `verify-release-versions.ts` 1–189：清单双向覆盖根 manifest 与 `packages/*/package.json`，逐包核 name/version/public-private，核 core VERSION、lock workspace 名称/版本及自有包旧版本字符串；收集错误后抛出，脚本入口 catch 设置 `exitCode=1`。当前声明为 15 包（10 public、5 private）；实际 manifest 的版本字段均为 0.9.45，自有依赖字段使用 workspace 引用。这里只读普通发布数据，未执行该校验得出 pass。

普通 producer `release.ts` 45–182 仅接受稳定版、rc.N、beta.N，先校验 current，再改同一声明清单和 core，调用 Bun 更新 lock，最后校验 target。`publish-release-packages.ts` 410–426 在提交命令前校验 rootVersion，459–470 有失败退出设置。release workflow 23–50 以 tag 去前缀作为校验参数，recovery 78–84 使用 `set -euo pipefail`；实际 workflow 退出结果未运行观测。现有 package-boundaries 测试只读 239–306 的声明，未借历史 R6 pass 作为本包验证。

R6 canonical `/files/94` 与当前 verifier 同 SHA，但原 manifest 明确为 selected evidence、不是 full-depth coverage claim；原报告 1–25 已读，保留已读重叠，不称历史未读或首次全文。旧 A11 原 `/issues/10` 与 root.md91–97 是任务分支推送/tag 集成关系问题，单独排除，不新增 related。共享历史机器导航含 6126 MD/JSON、4322397 value scalars，纳冻 59/排 60+、含 archive，verifier 33 命中全部保留（cap100、errors[]）；这不是亲读全部历史或所有 cause 无匹配的证明。

准确范围见 [source-manifest](source-manifest.json)：23 个产品/发布数据 semantic rows、794 行；测试声明 68 行；目标全文 1，其他 selected，指令 hash-only 2。JSON 字段投影与过宽 lock 导航截断单列，不把完整显示、机器命中或 raw recapture 当语义阅读。一次过宽导航的首诊断及原 raw 未落盘限制见 [diagnostics](diagnostics.json)。

未建立新的普通输入反例；不推断所有依赖协议、CI 主机、打包、native、权限/签名或发布链正确。产品/helper/import/fixture/test/build/install/release/native/network/Git 执行均 0，未改产品。26 个源/指令 pin 与 5 个有限 canonical/shared 元数据结束 SHA 均未变；不是全历史结束复扫。[history](canonical-history-read.json)、[projection](history-projection.json)、[classification](classification.json)、[ending](ending-checks.json)、[receipt](artifact-receipt.json)。
