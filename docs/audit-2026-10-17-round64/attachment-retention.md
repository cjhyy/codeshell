# ATTACH-R64-01 / P2：旧草稿清理提前删除已发送图片

同一会话两次添加同一张普通PNG，会返回不同附件ID，但[stageImageBuffer](/Users/admin/Documents/个人学习/代码学习/codeshell/packages/server/src/attachment-service.ts:256)按hash复用同一磁盘文件。A留作旧草稿，B正常发送后，[markAttachmentsSent](/Users/admin/Documents/个人学习/代码学习/codeshell/packages/server/src/attachment-service.ts:356)只给B记录sentAt。草稿期限24小时，已发送期限30天。

[cleanupAttachments](/Users/admin/Documents/个人学习/代码学习/codeshell/packages/server/src/attachment-service.ts:448)按每个ID计算期限；A到期后直接删除共享absPath，没有检查仍有效的B。[latestAttachmentState](/Users/admin/Documents/个人学习/代码学习/codeshell/packages/server/src/attachment-service.ts:875)也按ID而非物理文件聚合。结果B未到30天就丢失文件，最近附件列表因路径不存在而不再返回B。

普通序列是“粘贴A→移除草稿chip→同会话再次粘贴同图并发送B→次日启动清理”。UI移除只改本地state，没有写removedFromDraft；发送与启动无sessionId的TTL清理均有实际接线。精确真实调用范围见[174源码审查](evidence/server-attachments/report.md)及[176独立反证](evidence/attachment-peer/report.md)。没有把公开API测试冒称实际UI复现。

[首次guarded fixture](evidence/attachment-shared-path.test.ts)运行真实stage、markSent、cleanup、listRecent，PNG来自既有服务测试；只创建并删除自己的临时目录，用公开now参数推进清理，不改Date或真实系统时钟。[原始stdout/stderr](evidence/attachment-shared-path.first.log)、[首退出码](evidence/attachment-shared-path.first-exit.json)：**1 pass /11 expect /0 fail /0 skip，exit0，Completed**，无修支架或重跑。

复现同时验证：两ID不同但path相同；清理前B在最近附件中；B未过30天但共享文件被删；另一会话的独立已发送文件在同次清理后保留。测试断言记录当前错误，产品尚未修复。范围不包含真实Electron、重启操作、跨平台文件系统、网络或账号。

174按原6801历史库存做一次有限关键词/上下文去重，6个命中均是其他清理或cookie问题；旧图像格式候选、附件路径截断、尺寸限制问题的原条件亦不同。该查询有限，不宣称全历史根因穷尽。建议清理前按实际路径保护任何仍有效的引用，不能仅按每个ID独立删除共享内容。
