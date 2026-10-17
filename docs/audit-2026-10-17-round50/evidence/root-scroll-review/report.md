# Root84：消息滚动的有限静态复核

本次0新增正式问题、0候选、0新增关联。此前112条历史问题不变。独立审读自己的源码捕获后才查看已冻结85的manifest，不称盲审；没有读取85可变材料。

当前hook173行全文静态审读；Workbench与app.css仍只选段。真实调用给出items、workspace/activeId scope、connection/loading与active chat；section以hidden切换，scroll容器及transcript节点的ref绑定保持在同一实际结构。jump按钮调用resume/focus，打开会话和成功send显式resume。审批内容位于被观察transcript之内，textarea高度变化有list resize source路径。

未建立普通源码反例。曾考虑的“审批增长完全在被观察容器外”被实际Workbench846位置排除；“切换view就替换滚动ref节点”不符合当前hidden结构。程序scroll标记与near-bottom判断中的实际事件顺序、浏览器scroll anchoring/ResizeObserver/React帧与布局均未执行，不能从源码有限0认定这些机制正确，也没有制造任意坐标或时序当作观察到的bug。CSS只审列明布局规则，不认证整个样式级联。

既有83同SHA hook选读97行保留，当前全文不是首次阅读或全史新增173行；85另有重叠，不能相加唯一覆盖。fresh history机器扫描4693文件，12条scope紧凑投影实际阅读；190路径/56SHA/198cause命中及cap60不能代表所有历史语义已读。覆盖304/169/4170仍是dated45，不更新全局数量。

范围与计数：[source manifest](source-manifest.json)；原始[hook](hook-excerpts.first.json)、[Workbench初摘](workbench-excerpts.first.json)、[布局补摘](layout-source-excerpts.json)与[导航](layout-navigation.first.txt)保持。历史[扫描](history.json)和[实际12行投影](coverage-review.compact.json)分别记录机器与语义范围。初末[检查](ending-checks.json)、[验证](validation.json)和[回执](reviewer-receipt.json)。产品、helper、fixture、测试、React/DOM、clock/timer、模型、真实数据、native及业务网络运行均0。
