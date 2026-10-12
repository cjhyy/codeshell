# Cloud controller lease 验收记录（2026-10-12）

基线：`4c5a1934c`。本变更只修改 ProjectController 的锁保管、故障回归及测试隔离，
不修改 Account authority、恢复协议、Docker provider 或 Desktop 产品流程。

## 行为合同

- 固定 control 目录及其 sibling `.lock` 的 dev/inode；首次检测到目录丢失、替换、
  marker 丢失或心跳被外部修改后，当前 lease 永久失效。原 inode 归位不能复活。
- `proper-lockfile` 的同步适配层覆盖 acquisition、真实心跳和退出清理。心跳通过
  `O_NOFOLLOW` 打开的目录 fd 校验 inode 后执行 `futimesSync`，随后再校验公开路径。
- 新锁目录为 `0700`，包含唯一随机 `.owner-<UUID>`。marker 经独占/no-follow open
  和 fd fstat 捕获，必须为私有、零字节、单链接 regular file。
- 正常释放只移除自己的 marker；stale 回收只移除先前观察且仍匹配的候选 marker。
  未知、多 marker、非私有或其他不安全结构一律保全并拒绝获取。
- 最后的 pathname `rmdir` 即使发生替换，也不能删除已经发布不同 marker 的新 owner。
  `ENOTEMPTY` 保留该 owner；stale 获取必须失败，不得当作成功后继续占用。
- 失效 owner 的关闭不会释放 replacement；adoption 失败仍保留 pending barrier，
  控制服务关闭仍执行 provider/listener 清理并报告主失败。

仍兼容历史 proper-lockfile 的空 stale 目录。此保全协议要求新 owner 已发布自己的
marker；升级必须遵守既有离线部署/备份要求，先停止旧 controller，不声明与仍在运行的
无 marker 老版本混用时具有相同保证。现有 stale/update 窗口仍为 30 秒/10 秒。

## 真实故障证据

初始基线专项 7 例中 6 例失败：目录归位复活、replacement 误释放/续期、adoption
错误继续提交，以及控制服务在丢失 lease 后错误报告关闭成功。

仅 inode 检查的中间候选仍在实际 `fs.rmdirSync` syscall 前替换切点失败：release 和
stale-reclaim 都删除了另一真实 Node 进程已完成 acquire 的锁。最终 marker 版本在同一
切点保全新 inode/marker，新 owner 再次 `assertHeld`、真实心跳及独立 release 均成功。
没有把一个空 `mkdir` 当成新 owner 的验收证据。

独立 reviewer 另外使用实际旧 owner `SIGKILL` 后 age 的 stale 前置，再启动另一真实
Node owner，在相同切点复核通过。产品源 SHA256：
`671dce04bf21c345fa2ae9f5734b8a87554f6ef45b0ae1367c5d80fd4ab5eca5`。

## 验证终态

所有 Bun shard 使用 guarded runner 的 fresh HOME；新增进程/网络 fixture 在 Core
导入前安装拒绝策略，只捕获并启动固定 fixture 子进程。子进程退出后才删除私有目录。

| 验证                                                       | 结果                              |
| ---------------------------------------------------------- | --------------------------------- |
| `lock-recovery.test.ts`                                    | 11 pass / 62 assertions / 0 skip  |
| adoption、backup、control-server、manager、registry、proxy | 42 pass / 514 assertions / 0 skip |
| `cloud-account-control.test.ts`                            | 6 pass / 115 assertions / 0 skip  |
| `lifecycle.test.ts`（补 Core 导入前网络/进程 guard）       | 11 pass / 43 assertions / 0 skip  |
| Server typecheck、build、affected ESLint/Prettier          | 通过                              |
| 编译 Server 的独立 Node v25.8.1 smoke                      | 通过                              |
| 独立 reviewer 的双进程 release/stale syscall cut           | 通过                              |

编译 Server smoke 实际等待 10 秒心跳，完成 setup/create/start/stop/list/失效后拒绝
六次 HTTP 请求，验证 provider 和 listener 均关闭、replacement 保留，以及四个负向
transport/process 探针。runtime provider 是合成 fixture；没有调用 Docker、模型、真实
Account Services、Electron 或 macOS Keychain，不代表这些业务已经验收。

可重复命令（先完成依赖构建）：

```sh
node scripts/run-bun-test-shard.mjs --timeout 50000 packages/server/src/project-runtime/lock-recovery.test.ts
node scripts/run-bun-test-shard.mjs --timeout 50000 packages/server/src/project-runtime/account-adoption.test.ts packages/server/src/project-runtime/backup.test.ts packages/server/src/project-runtime/control-server.test.ts packages/server/src/project-runtime/manager.test.ts packages/server/src/project-runtime/registry.test.ts packages/server/src/project-runtime/proxy.test.ts
node scripts/run-bun-test-shard.mjs --timeout 50000 packages/server/src/project-runtime/cloud-account-control.test.ts
node scripts/run-bun-test-shard.mjs --timeout 50000 packages/server/src/project-runtime/lifecycle.test.ts
bun run --filter @cjhyy/code-shell-server typecheck
bun run --filter @cjhyy/code-shell-server build
node scripts/run-isolated-node-smoke.mjs packages/server/src/project-runtime/__fixtures__/controller-lock-native-smoke.mjs
```

本机原始日志保存在 `/tmp/codeshell-cloud-controller-lease-*-20261012.log`；独立复核回执为
`/tmp/review-controller-lock-rmdir-owner-native-receipt.json`。这些是本轮运行证据；长期
可重复入口是提交中的测试与 smoke fixture。
