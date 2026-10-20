# 当前覆盖与剩余边界

原4643个TS/TSX路径的through62旧账为368 full /377 selected /3898 unknown。并发主分支改变了4条原路径，其中service.ts原为full；未把旧SHA的全文记录套到新代码。当前字节重绑后为 **367 full /377 selected /3899 unknown，4276条尚不能标完整范围**。其余3条原本unknown，状态不变。[当前索引](evidence/coverage-current-index.json)、[Git绑定](evidence/coverage-source-git-bindings.json)。

本次只做同SHA承接/变更降级，未把Root读过的MCP diff、当前63/64源码片段或测试通过拼成full。full限原记录目的，unknown不表示从未读过。原61越EOF的旧deferred与原Root166范围澄清均不被本次数值解除。

同过滤库存现在4646，比原分母多旧57 fixture、本轮64 fixture、并发literal-override测试共3条，单列在[增量](evidence/current-ts-inventory-delta.json)，没有偷偷扩大或缩小原分母。非TS/TSX、跨模块/平台/运行行为尚无完整统一分母，无法精确给出全仓剩余量或剩余bug数。总目标active。
