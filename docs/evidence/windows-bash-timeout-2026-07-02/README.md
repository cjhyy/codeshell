# CodeShell Bash tool Windows timeout bug — evidence

## Session: s-mr3k8kst-4b585dac

### Files
- engine-2026-07-02.log — Full engine log (Bash tool.exec.end entries show timeout durations)
- transcript.jsonl — Full conversation transcript
- state.json — Session state

### Source files involved
- off.js.buggy — off.js sandbox hardcodes args: ["-c", command] (POSIX)
- off.js.fixed — Fix: use resolveShellInvocation() for platform-aware flags
- diagnostic-output.txt — safeSpawnShell output when -c is passed to cmd.exe

### Root cause
off.js wrap() returns { file: shell, args: ["-c", command] }.
On Windows, shell = cmd.exe, which uses /c (not -c).
cmd.exe -c is unrecognized → falls into interactive mode → timeout.

### Fix
Replace hardcoded -c with call to resolveShellInvocation(),
which already handles Windows (/c), POSIX (-c), PowerShell (-Command).

### Timeline (engine log)
- 14:00:11: Bash "echo hello" → 10,223ms timeout
- 14:01:18: Bash "echo hello" → 15,215ms timeout
- 14:09:24: Bash "echo START_TIME=..." → 15,242ms timeout
- 14:17:44: Bash after fix (no restart) → 10,195ms timeout
- 14:56:49: Bash after fix + restart → 84ms SUCCESS
