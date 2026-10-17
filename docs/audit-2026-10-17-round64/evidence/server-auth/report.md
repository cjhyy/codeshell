# Hub认证生命周期静态审查（预备172）

**0 正式 / 0 候选 / 0 新 related**。当前未建立普通用户可达的新反例；这是完整阅读两主文件后、结合真实入口的有限结论，不认证全部认证/安全机制正确。

Root报告冻结HEAD `5fa6a076db90682733c33fd46e1f473f9214d196`、分支 `codex/audit/auth-panel-attachments-round64-20261018`；本作者Git0。CODESHELL/AGENTS同SHA承接，源码只读，仅写exact tmp。

- auth-http.ts **1–290**、auth-store.ts **1–415**完整读到实际EOF，705行。审查initialize→setup→异步密码计算后锁内复核→login/grant→轮换/过期/最旧淘汰→authenticate/list→revoke/logout，以及输入、读取、写入、异常与finally分支。不是只核DTO。[逐生命周期检查](lifecycle-review.json)逐项列实际行号、反证与限度。
- 最小真实消费者为Headless创建/onRevoke、auth.handle先于受保护response跟踪、WS接入/逐消息/周期复查，及Web JSON POST/status helper、AuthGate普通提交/刷新/字段约束；实际语义范围共265产品行。对应 [source manifest](source-manifest.json) 明确完整/选段/导航/hash和相邻显示。合计 **970产品语义行、134既有测试声明行；显示1218行**。5产品文件=2full+3selected，2test selected，2instruction hash-only。声明不是测试通过；没有产品/helper/import/fixture/test/clock/crypto/native/process/account/network执行。
- 正常分支反证：setup/login在异步hash后重新核验锁内状态；grant回传实际撤销ID再触发清理；认证重新读取且TTL固定；Web pending/revision/finally保护普通提交与状态刷新。一次性bootstrap重启不再次披露是注释和既有声明的明确策略，未把“重启拿不到原令牌”强报新缺陷。具体未晋升理由见 [classification](classification.json)。
- 旧gate实际读取auth-round7选段59行、file-mutex-quality-round19选段22行及2个原inventory对象的compact字段。R03/R32/R38和FM19-1旧因保留不重报；不以本次Hub接线反证冒称旧logout或锁问题已修。原module_inventory187/188只是路径集合，没有逐文件SHA/full，不据其排除当前阅读，也不称本次首读或唯一新增覆盖。
- Root175 [共享历史投影](history-projection.json) 纳冻63排64+：6801 MD/JSON、5,060,759 JSON value scalar visits、errors=[]、含archive/hidden/unignored；HTTP72/store78命中均低cap100且全保存。机器命中、库存、旧读范围不等于根因全史穷尽；无新反例故未扩一次全史cause扫描。

未验证真实账号登录、HTTP/WS、30天等待/并发帧、真实磁盘故障/跨进程锁、所有恢复/平台/权限边界、cloud-account机制或全Host防护。旧动态失败方向均SKIP，不恢复、不替代运行。

初始pin先于正文/行导航；两主文件EOF均LF。Ending9源/指令pins及4份旧材料+shared batch均同，见 [ending](ending-checks.json)；未重hash全6801历史。首次旧metadata EOF断言exit1、两次历史工具显示截断、导航SyntaxWarning均保留原stdout/stderr/exit与 [诊断](diagnostics.json)。准确补选仅元数据，产品源正文输出未截断。所有child输出先保存后展示，无修复或仓库写入。
