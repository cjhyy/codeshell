# 本批质量复核

root 阅读了四份方向报告、保存 fixture、九份原始首次日志及关键当前调用方。最终确认 **4 项（1 P2、3 P3）**，候选 5 项；没有产品修复。

复核要求收紧两个看似可直接晋升的例子：Glob 返回的子集本身确实排序，未取得全体最新 200 的合同；OpenAI 人工首 delta 缺身份虽能触发无 start，但没有有效普通生产流证据。二者都保留原始通过观察，明确降为候选，没有改测试来让证据更好看。

Anthropic 由安装 SDK 内存 parser 验证正常顺序：inputJson 在 content_block_delta，contentBlock 在 content_block_stop。真实 provider/Facade/Web 进度路由错配，最终 response/内存 Transcript input 正确。fixture 的 Read/Write 是 tools=[] 的合成标签与对象，未运行或验证内建 file_path schema；传播到真正已声明工具的同一独立路由逻辑属于源码推断。该边界已由三方提出并校准，不声称完整 Engine 或真实工具执行。

Grep 证据是实际 Node fallback 与公开 glob 参数/等价过滤注释，外部程序通过 seam 拒绝启动。root 首次打开 [ripgrep 官方指南](https://raw.githubusercontent.com/BurntSushi/ripgrep/master/GUIDE.md) 与 [Git 官方 gitignore 格式](https://git-scm.com/docs/gitignore)，核对其 glob 采用相同模式语法以及 slash/双星目录含义；这是目录 glob 合同支持，不能替代真实 rg 或平台运行。

九个实际启动分片严格分账：七个 clean 合计 **69 tests / 372 expect**；thinking 的 1 pass / 13 expect calls 属于整个失败 shard，TUI 的 import 失败没有产品 assertions 执行。Root metadata preflight 在 subprocess.run 前停止，不能再加一个“失败 Bun 分片”，也不能据硬编码路径检查推断真正依赖解析失败。三份工具响应/metadata错误说明文档均与原始 Bun log 区分；没有修复、重跑或换方法验证失败的产品方向。

三份交叉复核均只读：

- [TUI worker 对 Files/Providers 的复核](evidence/cross-review-tui.md)。
- [Files worker 对 Providers/TUI 的复核](evidence/cross-review-files.md)。
- [Provider worker 对 Root/TUI 的复核](evidence/cross-review-providers.md)。

metadata 组装修正只补证据路径/引用/收据，不计产品执行。worker artifact receipt 表示各自生成时快照；最终材料以根 `evidence-index.json` 为准。源码哈希是证据定位，不证明所有文件逐行审查；绿色 baseline 不验证其他失败候选，也不证明真实 API/UI/native/跨平台、干净 build 或全仓无 bug。
