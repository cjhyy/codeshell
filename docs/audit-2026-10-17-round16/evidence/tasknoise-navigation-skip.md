# tasknoise 元数据失败与跳过

以下是首个可见工具响应的人工转录，**不是原始日志文件**。只有只读导航/查询失败；Bun fixture 首次运行通过，未重跑产品。

1. 查询 ANSI producer 的 `rg -n` 正则转义有误。首个响应：

```text
rg: regex parse error:
    (?:strip.*ANSI|ANSI_RE|stripAnsi|38:2|38;2|\\x1b\[|\\u001b\[)
                                                                     ^
error: unclosed character class
```

该 shell 调用后还有成功的独立文件读取，wrapper 最终 exit 0 不代表这个 rg 成功。没有保存子命令退出码，不虚构其值。跳过这个失败表达式；之后从已库存文件用独立 fixed-string 查询读取实际 producers，没有执行产品。

2. 错误猜测了不存在的 Core entry 文件。首个响应：

```text
rg: packages/core/src/internal.ts: No such file or directory (os error 2)
rg: packages/core/src/extension.ts: No such file or directory (os error 2)
```

组合 shell 最终 exit 0 来自之后的独立文件读取，rg 子退出码未单独保存。两个猜测引用均 SKIP；后续仅做实际 `rg --files` 库存，不寻找或执行这两个 entry 的替代品。它们不在 source manifest，也不是产品缺陷。helper 使用事先核验的绝对 `task-sanitizer.ts` import，与这些未使用的 entry 猜测无关。
