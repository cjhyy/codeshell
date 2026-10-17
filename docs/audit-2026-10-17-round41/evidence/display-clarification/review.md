# Display metadata clarification

原43 manifest 的 process-service 行声明175个显示行，但 displayedLineRanges 只列3段body（159行）；同一冻结行另外已有 additionalNavigationSnippetLines16条，全部在body范围外。因此原175及总display357计数成立，但主display ranges未单独完整表达它们。

本补充将已存在的body与16条导航显示行合并成canonical ranges，见[澄清JSON](display-clarification.json)。34–35、1123–1124均来自既有808648输出，不是补猜；其余导航出处也逐组保存。75行selected全部位于合并范围，普通语义222不变，formal/candidate/related均不增加。

只读取冻结metadata、引用已经存在的工具显示记录；未重读产品字节/源码、未改原23文件或其receipt，0产品/fixture/测试/native/Git。[本补充receipt](artifact-receipt.json)自排除。
