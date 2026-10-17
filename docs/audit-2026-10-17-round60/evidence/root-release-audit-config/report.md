# Root153：发布清单与export分类普通字段链

有限 **0正式、0候选、0新关联**。目标297行仅核静态配置与普通值验证，不等于整条发布链通过。[源清单](source-manifest.json)保留准确范围与JSON pointers，3份manifest仅所示属性，不当整文件行覆盖。

先亲读原R24 root-package-prep /sources/132，config当前同SHA、原scope只有45–105 release roster；R6 /files/90仅hash、root-package原报告虽列相关脚本但未给本目标全文范围，不能升级旧full或宣称首次未读。R6旧17pass不借为本批运行结果，A11任务分支打标签与旧watch静态候选均不重报。[原gate](prior-canonical-gate.json)。

当前config明确10public/5private，private仅版本同步。validatePublicReleaseOrder检查实际public列表中runtime/optional/peer依赖前置及private依赖；collectPublishEntries按non-code/runtime-excluded分别投影typeImport/runtimeImport，不把两种排除混同。validatePublishManifest对root、dist targets、import/types、non-code自指与bin做静态字段检查。

真实smoke112–145对同一配置加载manifest并执行validator；335–349/391–419只向type consumer投影typeImport，422–442只向runtime consumer投影runtimeImport。publish388–407/414–432沿相同public顺序加载、检查order/versions并生成commands，435–447按同index取definition。这里只核传递与字段选择，未执行这些函数或认证发布应答/远端接受/rollback。

实际root/core/web manifest所选exports与当前规则一致：web package.json是non-code，core CLI子路径禁止runtime smoke但仍保留类型路径；root bin/exports由别的build包定向复核。未建立正常当前输入下被遗漏或错误分类的新反例。没有用任意非法manifest/null/缺失dist或未知平台情况制造formal。

[共享batch](history-batch.json)纳冻59排60+：6126历史MD/JSON、4322397递归value scalar、0parse错，含archive。四目标109/34/33/57命中，cap100；build-meta只前100，其余全保存。这是机器导航，不是全史语义阅读。Root本目标57命中仅用于有限canonical定位，不由没有命中认新颖。

产品/helper/import/build/test/install/publish/native/network与Git执行均0，无新失败实验，既有失败方向仍跳过。所有源初始pin早于body/行号导航，结束同SHA。[结束](ending-checks.json)、[诊断](diagnostics.json)、[分类](classification.json)与[自排除收据](artifact-receipt.json)保存。本包冻结，有限0不证明全部发布合同正确。
