# 提示缓存基线脚本（2026-11-16）

[组装化与缓存成本方案](../../superpowers/specs/2026-11-16-assembled-agents-and-cache-cost-plan.md)第 1 节的比例由这个脚本算出。

`cache_baseline.py` 读本机的引擎日志（`~/.code-shell/logs/engine-*.log`）、调用追踪（`~/.code-shell/sessions/.model-traces/records/`）和 Mimi 会话 transcript 里的 `run_result` 记录，输出四张表：

1. 按用途的花费；
2. 主循环损失的原因归类，按缓存策略分期（0.10.0 之前是 `openai-implicit`，0.10.0 起是 `openai-hybrid`）；
3. 新 run 第一次请求和 run 内相邻请求对上一次请求的复用率；
4. Mimi 回合的间隔与步数。

```bash
python3 cache_baseline.py                      # 默认 ~/.code-shell，模型 openai/gpt-6.1-sol
python3 cache_baseline.py --model <模型> --model <模型>
```

说明：

- 输出含本机的用量和花费，不入库。方案文档里只引用比例。
- 脚本只输出汇总数字，不读也不打印提示词、会话标题或文件路径。
- 测试夹具会往同一份日志里写，脚本只保留真实会话的 id 形状。
- 调用追踪默认只保留 7 天，引擎日志保留更久，所以各表的时间范围不同。
- 价格取追踪记录里的价格快照，不计缓存写入溢价。快照里的缓存读取价是按"输入 × 0.1"估的。
- 不同缓存策略的时期不能合在一起看：策略随应用版本变了，合并后的占比两边都不代表。
- 头部指纹是每个进程一把随机密钥算出来的，跨进程重启不可比；指纹不包含首条用户上下文（指令文件和日期）。
- 归因方法写在脚本开头的注释里。它是启发式的，用来排优先级，不是节省承诺。
