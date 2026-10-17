# 元数据首次组装错误记录

首次执行 `python3 docs/audit-2026-10-17-round7/evidence/providers-assemble.py` 的工具返回 exit 1。原始 stderr 通过工具返回，下面是该返回的转录；不是重新执行所得的 raw log：

```text
Traceback (most recent call last):
  File "/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17-round7/evidence/providers-assemble.py", line 85, in <module>
    "relativePath": str(path.relative_to(ROOT)),
                        ~~~~~~~~~~~~~~~~^^^^^^
  File "/opt/homebrew/Cellar/python@3.14/3.14.5/Frameworks/Python.framework/Versions/3.14/lib/python3.14/pathlib/__init__.py", line 490, in relative_to
    raise ValueError(f"{str(self)!r} is not in the subpath of {str(other)!r}")
ValueError: '/Users/admin/Documents/个人学习/代码学习/codeshell/node_modules/.bun/@anthropic-ai+sdk@0.39.0+d56b95ac411b1cdd/node_modules/@anthropic-ai/sdk/package.json' is not in the subpath of '/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell'
```

工作树使用既有共享依赖，`packages/core/node_modules/@anthropic-ai/sdk` 最终解析到 primary 的 node_modules。组装器原来错误假设实际 SDK 路径都在本工作树根内；文件本身已能读取，没有 SDK 导入或测试运行失败。

第二次元数据执行继续读到另一处路径拼写错误：SDK runtime `streaming.mjs` 在包根，组装器误写 `lib/streaming.mjs`。工具返回 exit 1，末行如下（同为工具输出转录）：

```text
FileNotFoundError: [Errno 2] No such file or directory: '/Users/admin/Documents/个人学习/代码学习/codeshell/node_modules/.bun/@anthropic-ai+sdk@0.39.0+d56b95ac411b1cdd/node_modules/@anthropic-ai/sdk/lib/streaming.mjs'
```

仅修正收据路径字段：`relativePath` 使用工作树可访问的逻辑 import 路径，另记 `resolvedAbsolutePath` 与实际文件哈希；runtime 元数据路径改为实际的包根 `streaming.mjs`。然后重新组装元数据，没有修改或重跑任何产品 fixture/测试，没有重建或安装依赖。此前 thinking fixture 的首次失败及 SKIP 保持不变。这两次元数据错误不是 Bun shard，不能计入测试成功或失败数量。
