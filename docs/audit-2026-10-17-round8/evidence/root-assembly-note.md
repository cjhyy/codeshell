# Root metadata assembly diagnostic

The first `python3 docs/audit-2026-10-17-round8/evidence/assemble-audit.py` returned tool exit 1 while looking for a `.first.exit.txt` receipt. Tool-response transcription (not a raw Bun log):

```text
Traceback (most recent call last):
  File "/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17-round8/evidence/assemble-audit.py", line 44, in <module>
    e = EV / (name + ".first.exit.txt"); code = int(e.read_text().strip())
                                                    ~~~~~~~~~~~^^
  File "/opt/homebrew/Cellar/python@3.14/3.14.5/Frameworks/Python.framework/Versions/3.14/lib/python3.14/pathlib/__init__.py", line 787, in read_text
    with self.open(mode='r', encoding=encoding, errors=errors, newline=newline) as f:
         ~~~~~~~~~^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "/opt/homebrew/Cellar/python@3.14/3.14.5/Frameworks/Python.framework/Versions/3.14/lib/python3.14/pathlib/__init__.py", line 771, in open
    return io.open(self, mode, buffering, encoding, errors, newline)
           ~~~~~~~^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
FileNotFoundError: [Errno 2] No such file or directory: '/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17-round8/evidence/plugins-command-metadata.first.exit.txt'
```

The collector assumed one extension instead of reading existing worker receipts. Only receipt-selection/parsing metadata was corrected and assembled again from unchanged first logs/exits. This script never executes product code; no product fixture was repaired, retried or validated by another method. The two failed Question directions remain SKIP.
