# Read-only cross review：migration lane

结论：**无阻断意见；0 formal / 1 candidate / 1 old related 的分级与现有证据相称。** 本复核未执行产品、测试、installer 或 metadata assemble 脚本，未修改被审报告/fixture、Git、依赖或共享产物。

已核对 migration.md、两份实际 fixture、两份 raw/exit、validation/candidates/findings/artifact receipt、全部 source manifest 及聚焦产品源码。真实 parseSource 的 `.git/` inferredName 与 `github:...git.git` 返回值均由对应断言证明，normal local path、GitHub ref/subdir、scoped npm exact-version/tag/default selector、SCP SSH 都有明确控制。报告将两个边界留作同一来源规范化候选，没有把纯 parser 输出外推为真实 clone、安装失败、目录写入或远程存在性结果。静态 CLI source/name 接线与明确支持的普通来源形态已区分；未建立边界输入支持合同/正常应用生产者的缺口写明。

migrateConfig 的普通数据回填、保留作者 catalogId/custom kind、输入不变、重复迁移稳定与 version 1 不重跑早期步骤均与 fixture 匹配。当前 registry 连续 0→1→2，旧 round4 C-SET-02 gap/future stamp 仅关联排除，未重新验证或计新 bug；fixture 不含 sandbox 字段，v1→v2 的无该字段早退不被写成 sandbox 行为验证。manifest normalization 只静态阅读且没有运行文件操作。

两份原始日志分别 **7 pass / 11 expect**、**4 pass / 16 expect**，均 `Completed Bun shard`、0 fail/skip、exit 0；raw SHA 与首跑 receipt 一致，合计 **11 pass / 27 expect**。报告已明确三次 metadata failures（两次猜路径导航、一次测试之后可选 Node root semver lookup），没有 Bun/产品失败、修 fixture、重跑、恢复旧失败方向或 installed semver 已 pin 的主张。JSON 查重的 281,762 是所有递归 leaves，不应与其他 lane 仅字符串 leaves 的 200,618 混用。

元数据只读核对结果：

```json
{
  "sourceFiles": 27,
  "artifacts": 15,
  "localLinks": 23,
  "sourceErrors": [],
  "artifactErrors": [],
  "linkErrors": []
}
```

全部冻结源 Git blob 的 SHA/bytes 与 current receipt 相符；逐文件选读范围仍按被审 manifest，哈希验证不构成完整源码阅读声明。15 个 artifact 字节/哈希均符，23 个本地链接及其有行号的引用可定位。

## 本复核的一次静态 locator 跳过

在已有报告 source 路径阅读前，复核者曾误猜 `packages/core/src/migration` 目录，命令为 `rg --files packages/core/src/migration packages/core/src | rg ...`。原始工具响应的明确转录：

```text
rg: packages/core/src/migration: No such file or directory (os error 2)
```

工具返回 `exit_code: 0` 是 pipeline 后段有匹配，不能证明该猜测目录存在。该不存在目录 SKIP，不作为 source 或产品故障。后续只读已在被审报告中明确给出的 settings/migrate-config.ts 与 plugins/installer/parseSource.ts 等真实源路径；没有运行 migration 或 installer。没有恢复该错误 locator、修 fixture 或新增测试。
