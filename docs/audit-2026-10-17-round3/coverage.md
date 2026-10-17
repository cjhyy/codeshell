# 第三批覆盖边界

冻结基线 `0f83bbfdfb8f2c6f31148250bd6544f5325c16e7`，相对上一源码基线仅新增审查文档。新旧报告各自冻结，不能将各批发现直接相加为当前全仓剩余bug数量。

| 模块 | 本批实际审阅/执行 | 仍未覆盖 |
| --- | --- | --- |
| Host | runtime/register/start/stop/rollback与host request dispatch；纯fake adapter正常基线和生产创建点静态 | 真实native adapter、异步副作用adapter、跨进程启动/退出 |
| Link | manifest/catalog/file-selection/operation contracts、普通schema/result快照；纯resolver观察与基线 | 真实GitHub/Figma/API、UI/IPC/持久source端到端、授权方向 |
| CDP | legacy driver几何/keymap/scroll/read/索引全部主要源文件；fake sender数据、几何独立判定 | 真实浏览器/CSS transforms、遮挡命中、OS键盘布局、iframe滚动；默认Desktop不使用该兼容driver |
| browser-devtools | inspector DOM/Console/Performance实际callback与fake page/VM普通数据；生产适配器接线静态 | 真实CSS排版/真实浏览器库事件、Desktop/Electron完整E2E |
| Arena | claim parser/状态/ledger/adjudication、summary/iterate/planner/provider普通数据选择性阅读；实际model-free早退 | 私有源码非默认Host；真实评审/共识模型、完整会话，失败reviewer-cap方向不重试 |
| optimization-lab | correction/grading/reflection、plan/dataset/report/candidate/ledger/store普通数据选择性阅读；纯grading/reflection | feature未开启、完整实验/真实付费provider/采纳/崩溃/锁与真实并发 |
| Server | room metadata/seq/history、CodexJSONL事件投影、HubRunReplay、title、worker bridge和Hub session普通数据链路选择性阅读；真实本地RoomManager与分页、fake agent | 真实CLI/worker、手机/HTTP/WS/UI；认证/权限/安全方向、完整Server功能 |
| Core model-traces | store/classification/summary/search/list/session pagination/retention相关段静态核对，无新增确认 | context recorder/所有provider/事件落盘完整生命周期；不宣称独立全量测试 |
| 其他包/独立Panel仓库 | 本批依赖上一冻结报告作导航/查重，不重新宣称动态覆盖 | 仍需后续轮次；主目标保持全仓，不缩为本表 |

所有动态仅guarded Bun、自有临时数据、纯函数/fake adapter或Node VM中的真实callback。未执行实际外部消息、网络模型、真实用户数据操作，未构建/安装依赖或更改产品源码。部分包导入复用现有node_modules与预构建dist，具体fixture边界逐项披露。

源文件哈希只证明被列文件与冻结blob一致，不证明每个文件逐行/逐分支覆盖。成功shard是有限例子的证据；全仓typecheck/lint/build、全量测试、所有OS和真实平台验收均未宣称完成。
