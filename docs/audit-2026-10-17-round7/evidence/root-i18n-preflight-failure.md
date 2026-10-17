# Translation fixture preflight failure — no Bun test launched

Frozen source `1b04838474bcd57212f80f791d0e268a00d347e3`. The unchanged [root-i18n-contract.test.ts](root-i18n-contract.test.ts) was prepared to inspect the assembled Desktop dictionary and direct Web mobile namespace, with ordinary interpolation controls. Desktop's `dict.ts` imports `mobile` via the Web package root, whose export points at `dist/index.js`.

The first metadata inventory returned tool exit 1:

```text
53:        messageCount: "{count} 条",
219:        messageCount: "{count} messages",
ls: packages/web/dist/i18n/mobile.js: No such file or directory
ls: packages/web/dist/index.js: No such file or directory
```

The following first receipt-capture invocation also returned tool exit 1 while reading dependency bytes, before `subprocess.run` could launch the guarded runner:

```text
Traceback (most recent call last):
  File "<stdin>", line 6, in <module>
  File "/opt/homebrew/Cellar/python@3.14/3.14.5/Frameworks/Python.framework/Versions/3.14/lib/python3.14/pathlib/__init__.py", line 777, in read_bytes
    with self.open(mode='rb', buffering=0) as f:
         ~~~~~~~~~^^^^^^^^^^^^^^^^^^^^^^^^
  File "/opt/homebrew/Cellar/python@3.14/3.14.5/Frameworks/Python.framework/Versions/3.14/lib/python3.14/pathlib/__init__.py", line 771, in open
    return io.open(self, mode, buffering, encoding, errors, newline)
           ~~~~~~~^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
FileNotFoundError: [Errno 2] No such file or directory: '/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/web/dist/index.js'
```

These blocks transcribe tool responses; they are not raw Bun stdout/stderr logs. The attempted command was `node scripts/run-bun-test-shard.mjs --timeout 30000 docs/audit-2026-10-17-round7/evidence/root-i18n-contract.test.ts packages/desktop/src/renderer/i18n/translate.test.ts packages/desktop/src/renderer/i18n/dict.test.ts`, but it **never launched**. No pass/fail/expect/JUnit/completion count exists for this direction, and no `root-i18n.first.log`, exit file or receipt was produced. It must not be counted as an attempted Bun shard or as a product failure.

The receipt collector hard-coded checkout-local `packages/web/dist` paths. Actual package resolution may use a shared dependency target; it was not tested or resolved in this direction. This preflight failure does not establish a broken runtime import, unavailable shared dependency, missing published artifact, or product defect.

No dist rebuild, dependency repair, test retry, alias, alternative import/runner or alternate validation was used. The translation direction is SKIP; all its planned observations remain unexecuted.
