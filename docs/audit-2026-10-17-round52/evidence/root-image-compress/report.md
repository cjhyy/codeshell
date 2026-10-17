# Root103：附件图片压缩及细长尺寸边界

冻结源码 `00e47e070fdadd6e5882330ba3b0d3962a93a47f`。提出 **1项P3静态确认候选 IMAGE-R103-C1**，由Root统一正式编号；独立104复核不是第二个问题。未执行产品、helper、fixture、测试、DOM/canvas、图片解码、timer、模型、native或业务网络。

普通File输入只经过数量、MIME和10MiB字节门槛，没有长宽比限制。ChatView先buildAttachments，再以实际imageDetail执行compressBatch，随后用返回的dataUrl暂存并改写路径元数据，因此“压缩后仍用旧路径”被真实调用链反驳，不晋升。

有效的1×4096细长图片在low1024或standard1568下仍会进入缩放，即使原字节小于2MiB；短边分别为Math.round(0.25)和Math.round(0.3828125)，均为0。零宽canvas的toBlob回调null，三次编码继续后返回原附件，选择的长边上限未应用。该结论来自源码和[WHATWG规范](https://html.spec.whatwg.org/multipage/canvas.html#dom-canvas-toblob)推导，未实际运行；原图保留，不声称丢图、账单金额或所有图片失败。普通比例和high小图早退为反例。建议正尺寸缩放后短边至少1。详见[提案](proposal.json)、[规范阅读记录](external-standard.json)。

源码218行全部显示，但本稿保守只把尺寸、普通控制流与消费者范围列为selected：产品310行、测试声明69行，共379行；正文显示463行。未确认注释内供应商价格、token公式、实际engine门槛或Host完整机制。[范围](source-manifest.json)、[原源码摘录](source-excerpts.json)、[消费者摘录](consumer-source-excerpts.json)。

查重覆盖原5017份历史MD/JSON，递归JSON值标量，含archive，不查key；38份目标范围投影已读，未建立同SHA旧全文排除。77path、20SHA、1227宽泛压缩命中以及各60保留上限不等于全部语义阅读。聚焦52thin与52输入匹配均为thinking/narrow文字、SHA或数字误命中，零canvas原因0匹配；104个实际匹配短段完整补读，R7 providers上下文也核对为thinking字段。它们未建立相同旧原因，不作全历史语义不存在证明。[原查重](history.json)、[聚焦查重](focused-history.json)、[实际短段](focused-read-compact.json)。

首次宽输出4051/4000和聚焦展开12766/12500发生截断，exit0；原保存机器结果完整，后者仅用紧凑匹配补读，不能把未显示长上下文说成已读。首诊断及撤回线索见[限制](first-metadata-limits.json)。四源pin与原5017历史字节结束一致，[结束核对](ending-checks.json)。全仓覆盖计数未重算，未重试此前失败方向，Git操作0。
