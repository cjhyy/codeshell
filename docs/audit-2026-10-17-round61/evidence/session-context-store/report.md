# 外部运行时会话上下文表：有限静态审查

新增 **0 formal / 0 candidate / 0 related**。Root 给定基线 `659b6b2ce5888723a40ce046cbbf643382cb130b`；本代理未执行 Git 或任何产品函数。

实际目标是 **memory-only 的 thread/key→live ToolHostRef Map**，不是 cwd/会话内容持久化存储。目标全文显示 153 行，但普通 Map 数据规则与机制边界分账，未把完整显示升级为全部身份/权限合同审完。

真实链：Desktop `external-runtime-service.ts` 708–714 仅在已读 kind/cwd/model 条件相等时选择 persisted runtimeSessionId；907–934 将 request.sessionId、cwd、恢复 ID 与 initialContext 传给 factory。factory 129–179 每次创建 fresh store 和独立 bridge，使用同一个 `codeshell-${businessSessionId}` 作 pin 与 register key，注册后才启动 runtime；144–153 的 close 先注销。bridge 132–143 优先用该 pin，277–280/318–319 以同 store 的当前 generation 查表；注销或缺键返回的拒绝数据分支可见。未建立正常 producer 与消费者之间的新字段/键不吻合。

helper 的 bumpGeneration 清表 API、替换/clear/JSON 输出规则在已读范围内；实际 production factory 是 fresh store，不能借 helper 注释或测试声明声称已验证重启 fencing。持久 binding reader/writer、恢复后的 runtime、权限/metadata 来源真实性、相邻 host execute 与 I/O/process 生命周期仅到显示边界，未认证其正确性。未以伪造 ID/null/store 或坏路径造反例。

共享历史机器导航含 6244 MD/JSON、4350476 递归 value scalars，纳冻 60/排 61+、含 archive；本目标 25 命中全保存 cap100、errors[]。亲读原 R28 inventory `/files/186` 只有 bytes/lines/SHA，派生 claims929/930 与 index495 也无 semantic-full 范围；这不能证明历史未读。旧 R2-01 原 `root.md`7–15 是 Claude encodeCwd 项目 bucket 碰撞，单独排除，不重复登记；原历史测试结果不借作本次 pass。旧 SDK resolver/会话导入失败动态方向继续跳过。

范围见 [manifest](source-manifest.json)：产品 selected 294 行，现有测试仅声明 31 行，nav-only 1、指令 hash-only 2、semantic-full 0；body 显示 635 行，连同导航的逐文件 union 727 行。首次猜测旧目录失败为 metadata rg exit2，原 stdout/stderr/exit 和纠正路径见 [diagnostics](diagnostics.json)，无产品重试或截断。产品/helper/import/fixture/test/CLI/model/native/network/Git 执行均 0，未读真实用户存储、会话或配置数据。

8 个源/指令和 5 个有限 canonical/shared 输入结束 SHA 均未变，非全历史重新扫描。[history](canonical-original-read.json)、[projection](history-projection.json)、[classification](classification.json)、[ending](ending-checks.json)、[receipt](artifact-receipt.json)。
