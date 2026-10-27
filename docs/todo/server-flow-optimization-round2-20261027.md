# Server 全流程优化：2026-10-27 第二轮

承接[首轮](server-flow-optimization-20261027.md)，本轮完成深页历史读取、静态条件请求、
统一网站账号管理修复，以及[可扩展账号上下文设计](account-context-distribution-design.md)。
本轮产品源码候选为 `8a402b3fc`。最终集成另保留并行任务合入本地 main 的
`545628951`：连接取消结算、exit-0 EPIPE 和后台孙进程持有 stdio 的退出修复；新增原生
fixture 同步改用现有子进程打包 helper，兼容最新分片门禁。未进行生产部署或正式发版。

## 实际改动

- **深页历史**：在读取/解析 state 前排除游标之前的候选；保留排序、工作区、归档、
  子会话和筛选语义。1000 候选回归包含同时间戳及各类排除项，读取数从 907 降至 7，
  返回相同两项。目录枚举和排序仍是全量，尚未加入索引。
- **静态条件请求**：根据已打开文件的设备/inode/大小/纳秒 mtime/ctime 生成弱 ETag。
  GET/HEAD 支持 If-None-Match 的强弱比较、列表与星号；无效列表整体回退普通响应。
  校验路径和文件身份后才返回 304，不创建 reader、不发送 body/Content-Length，并
  关闭文件句柄。保留既有缓存策略；替换文件、越界链接、断开与失败清理仍需通过。
- **资料管理**：保存响应更新后续比较基线，昵称/用户名 A→B→A 都会提交。真实
  profile API 只返回 id/username/displayName，改为独立三字段校验；role 继续来自
  session/overview，不从资料保存结果推断。坏响应保留草稿，旧账号迟到结果不能覆盖新账号。
- **登录方式恢复**：匿名 status 请求独立 loading/error/retry，短暂失败不永久隐藏
  注册/GitHub。恢复、聚焦、登录和退出重读，旧请求不能覆盖新结果；密码登录仍可用。
  服务关闭注册后回登录表单，同时移除只适用于注册的密码确认错误。
- **后续机制**：已设计模块注册表、独立版本与 revision、作用域、CAS、账号生命周期、
  本机偏好覆盖与秘密引用。首批资料、主题/语言、可用功能；context API 和跨端同步
  尚未实现，按根 TODO 的 Account → Web → Desktop 顺序实施。

## 性能样本

隔离本机 Node HTTP fixture 调用实际 Hub sessions list handler，1000 个真实历史目录，
每个 state 追加 16 KiB 数据，游标跨过 900 项、取 50 项（另取 lookahead）。认证被
fixture 替换为允许；网络限制到准确本机 origin。每组先预热一次，再测五次。

| 版本   | 五次耗时（ms）                             | 中位数（ms） |
| ------ | ------------------------------------------ | -----------: |
| 修改前 | 337.02 / 334.59 / 292.26 / 344.08 / 291.84 |       334.59 |
| 修改后 | 48.33 / 50.10 / 42.67 / 39.42 / 37.18      |        42.67 |

该样本中位数减少约 87%，结果 ID 相同。它证明深页 state I/O 的收益，不代表真实认证、
部署吞吐、P99 或大目录索引性能。原始脚本/日志保留于执行机器 `/tmp/codeshell-round2-history-*`。

## 验证证据

使用隔离 HOME 的 guarded Bun runner，完整零失败 JUnit，0 跳过：

| 范围                                      | 测试 | 文件 |
| ----------------------------------------- | ---: | ---: |
| Core SessionManager / Host / Hub 历史读取 |  105 |   21 |
| Server serve / 原生静态 / Mobile static   |  114 |   16 |
| Web 全量                                  |  708 |   64 |
| 合计                                      |  927 |  101 |

全仓 `bun run typecheck` 构建与检查通过；最后 Web 修复后重建 Web 并再次通过 14 个
工作区 `typecheck:workspaces`。全仓 ESLint 0 errors、99 warnings，等于既有基线；
测试分片覆盖 2478 文件、workflow 测试路径与 Engine 构造边界通过。原生 Hub 生命周期
门禁与九阶段真实 Node/Worker smoke 通过，包括会话续接、配置热更新和两次正常停服。

Chrome + 真实 `codeshell-services@0245869b5a092fc8312a5d023538ed69c66f82fd` Account
服务，在临时 SQLite、自签 HTTPS、准确 origin 网络限制下验证 8/8：503 重试；真实
密码登录与 Secure/HttpOnly Cookie；昵称/用户名分别 A→B→A；刷新恢复；会话列表及
退出其他会话；管理员用户与统计；退出清 Cookie/未认证；零外网/云项目/OAuth 请求与
页面错误。采用本轮实际生产 Web 组件构建，服务源码未改。测试数据库与 TLS 私钥已删除。
最终报告/截图位于执行机器临时证据目录 `codeshell-account-real-browser-Ry8Rbp`；该
受控本地账号验收不等于真实第三方 OAuth、生产账号或发布验证。

远端 `ci.yml` 必须针对最终候选全绿后才快进 `main`；运行链接随最终交付提供。当前
Docker daemon 未运行，本轮未声称完成本地 Linux Docker 验收；远端平台结果按 CI 实际
完成范围记录，不替代 Windows Server 正式包、反代或实体手机验收。

## 后续

- 按账号上下文设计分阶段实现，先打通 Account 存储/恢复/CAS 与 Web 实际偏好消费。
- 固定部署候选再测真实认证 + 历史端到端延迟，依据目录枚举占比决定索引方案。
- Web 构建主 JS 约 777 kB（gzip 239 kB），仍有 500 kB 提示；按真实路由依赖评估拆分。
- 继续正式 Linux/Windows、反向代理和实体手机弱网验收；不以单机样本关闭发布清单。
