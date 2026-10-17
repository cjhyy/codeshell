# Web storage 与环境书签：有限静态审查

**0 正式 / 0 候选 / 0 新关联**；旧W10精确因果排除1项，不重复登记。产品/helper/测试/React/浏览器/真实localStorage/crypto/网络/native及Git执行均0，未改产品。

[范围清单](source-manifest.json)与[摘录](source-excerpts.txt)保留普通生产链：mobile App与Web DesktopApp实际调用useRemoteApp，后者接useRemoteSocket；hook按当前origin建立/ws，读取deviceStore固定cs.*键，并调用32字节→小写hex的generateSecret。pair.ok写新deviceId后再次读取secret再发auth。这仍符合旧 [W10 原因](prior-canonical-decisions.json)：setItem配额失败没有内存缓存时两次mint可能不同；本次不重新复现、不发布新问题，也不把best-effort注释当恢复正确性证明。server secretHash比较这里只读注释，不冒充认证机制复核。

环境书签使用独立codeshell.environments.v1键，地址规范到origin+入口路径；save按规范地址替换、保留已保存environmentId且最多32条，remove使用同一地址转换。真实Menu捕获读写异常、接保存当前/手动表单/删除，go交给navigate或location.assign；所读Desktop实例不传navigate。API scope URL投影只做客户端字符串分支核对，不由它认证跨环境权限、cookie/credential隔离、Host identity或迁移正在运行的job。projectReferenceKey不以任意合法形状的无真实生产者输入凑新缺陷。

一个长度差异仅作未晋升线索：descriptor上限128，书签名称上限80；所读server describeEnvironment58–69生产固定短名，尚未建立普通长名称的实际生产者/应成功保存的错误consumer，故不列候选。这不等于所有外部descriptor都短或整个表单正确。

门槛在正文前完成：R5原/sources8、9同SHA whole-file分别覆盖environment/storage；R18原/files2与MD限定再次确认environment full source read。此次定向旧重叠不称首次/新唯一全文；deviceCredential的28命中是库存类线索，没有据此认定未读。 [原输入](prior-canonical-inputs.json)与[共享导航投影](history-projection.json)记录5850 MD/JSON（含冻57排58+）、recursiveJSON values与archives、4251467机器标量访问，三目标39/28/87命中全部保存；机器访问不作本review语义阅读数或重复加总。实际只亲读4份原canonical/MD的限定窗口。

当前12产品selected **506**行、2既有测试声明selected **97**行（执行0），合计603，display union **888**；WebsiteShell仅导航，指令同SHA沿用。物理全显示与外部机制边界不升级semantic full或全局覆盖。 [diagnostics](diagnostics.json)保留首次实际库存raw exit0及一次正常空匹配exit1，未重开历史mobile/i18n失败方向；[ending](ending.json)17源码/指令pin与5限定元数据输入SHA均同，不冒称重核全5850库存。见 [自排除收据](artifact-receipt.json)。
