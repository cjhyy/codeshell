# First metadata preflight failure — dynamic parser direction skipped

This is a transcription of the first `exec_command` tool response, not a reconstructed Bun log. The metadata-only Python command checked exact source-file presence plus `node_modules/saxes/package.json` and `node_modules/yauzl/package.json` in the checkout root, then asserted that all checks were true. No product import, parser execution, dependency installation, or test invocation occurred. The command failed before writing `docinput-preflight.json` or the intended fixture.

First tool response: exit code **1**; output:

```text
Traceback (most recent call last):
  File "<stdin>", line 9, in <module>
AssertionError
```

The combined assertion does not identify which package check failed and does not establish whether Bun could resolve either dependency through another location. The guessed root package locations were not repaired or replaced. The entire `parseDocument` dynamic direction is skipped for this batch; no alternate validator, mock module, ZIP parser, or second fixture execution was used. Thus the UTF-8 prefix observation remains static only. This is **not** a Bun failure or a confirmed product dependency bug.
